import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { type ShipLogsRequest, ShipLogsRequestSchema } from '@shipkeep/proto-ts';
import { describe, expect, it } from 'vitest';

import { LogBatches } from '../application/log-batches';

import { relayShipLogs } from './log-stream';

const node = { organizationId: 'o1', nodeId: 'n1', serial: '01' };
const open = (epoch: bigint) =>
  create(ShipLogsRequestSchema, { frame: { case: 'open', value: { leaseEpoch: epoch } } });
const batch = (seq: bigint) =>
  create(ShipLogsRequestSchema, { frame: { case: 'batch', value: { seq, entries: [] } } });

async function* frames(...items: ShipLogsRequest[]): AsyncGenerator<ShipLogsRequest> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}

async function run(
  batches: LogBatches,
  ...items: ShipLogsRequest[]
): Promise<{ acks: bigint[]; code?: Code }> {
  const acks: bigint[] = [];
  try {
    for await (const response of relayShipLogs(batches, frames(...items), node, () =>
      Promise.resolve(3n),
    ))
      if (response.frame.case === 'ack') acks.push(response.frame.value.seq);
  } catch (error) {
    return { acks, code: error instanceof ConnectError ? error.code : Code.Unknown };
  }
  return { acks };
}

function accepting(fail = false): { batches: LogBatches; kept: bigint[] } {
  const batches = new LogBatches();
  const kept: bigint[] = [];
  batches.register((_identity, value) => {
    if (fail) return Promise.reject(new Error('store down'));
    kept.push(value.seq);
    return Promise.resolve();
  });
  return { batches, kept };
}

describe('the agent log stream (ADR 0029)', () => {
  it('acknowledges each batch once it is kept, in order', async () => {
    const { batches, kept } = accepting();
    expect(await run(batches, open(3n), batch(1n), batch(2n))).toEqual({ acks: [1n, 2n] });
    expect(kept).toEqual([1n, 2n]);
  });

  it('refuses a missing open, a stale epoch, and batches out of order', async () => {
    expect((await run(accepting().batches, batch(1n))).code).toBe(Code.FailedPrecondition);
    expect((await run(accepting().batches, open(2n), batch(1n))).code).toBe(
      Code.FailedPrecondition,
    );
    expect(await run(accepting().batches, open(3n), batch(1n), batch(3n))).toEqual({
      acks: [1n],
      code: Code.InvalidArgument,
    });
    expect((await run(accepting().batches, open(3n), batch(0n))).code).toBe(Code.InvalidArgument);
    expect((await run(accepting().batches, open(3n), batch(1n), open(3n))).code).toBe(
      Code.InvalidArgument,
    );
  });

  it('withholds the acknowledgement when the batch is not kept, and refuses without a store', async () => {
    expect(await run(accepting(true).batches, open(3n), batch(1n))).toEqual({
      acks: [],
      code: Code.Unavailable,
    });
    expect((await run(new LogBatches(), open(3n))).code).toBe(Code.FailedPrecondition);
  });
});
