import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  type ShipLogsRequest,
  type ShipLogsResponse,
  ShipLogsResponseSchema,
} from '@shipkeep/proto-ts';

import type { LogBatches } from '../application/log-batches';
import type { NodeIdentity } from '../domain/node-identity';

/**
 * The agent's log stream (ADR 0029): `LogsOpen` with the node's current lease epoch, then batches
 * numbered from 1, each acknowledged once stored. A stale epoch, a missing open, a number out of
 * order or a store failure ends the stream; the agent sends again from its cursor.
 */
export async function* relayShipLogs(
  batches: LogBatches,
  requests: AsyncIterable<ShipLogsRequest>,
  node: NodeIdentity,
  leaseEpoch: () => Promise<bigint>,
): AsyncGenerator<ShipLogsResponse> {
  if (!batches.accepting) throw new ConnectError('logs are not kept', Code.FailedPrecondition);
  const incoming = requests[Symbol.asyncIterator]();
  const first = await incoming.next();
  if (
    first.done ||
    first.value.frame.case !== 'open' ||
    first.value.frame.value.leaseEpoch !== (await leaseEpoch())
  )
    throw new ConnectError('stale or missing log stream open', Code.FailedPrecondition);
  for (let expected = 1n; ; expected++) {
    const next = await incoming.next();
    if (next.done) return;
    const frame = next.value.frame;
    if (frame.case !== 'batch' || frame.value.seq !== expected)
      throw new ConnectError('log batch out of order', Code.InvalidArgument);
    try {
      await batches.deliver(node, frame.value);
    } catch {
      throw new ConnectError('log batch not kept', Code.Unavailable);
    }
    yield create(ShipLogsResponseSchema, {
      frame: { case: 'ack', value: { seq: frame.value.seq } },
    });
  }
}
