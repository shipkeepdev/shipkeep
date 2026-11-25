import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { Injectable } from '@nestjs/common';
import {
  type ShipLogsRequest,
  type ShipLogsResponse,
  ShipLogsResponseSchema,
} from '@shipkeep/proto-ts';

import { AuthenticateNode } from '../application/authenticate-node';
import { LogBatches } from '../application/log-batches';
import { NodeAuthenticationError, type NodeIdentity } from '../domain/node-identity';

import { nextFrame, tick, waitForFrame } from './stream-frames';

/** How long a stream may wait for a batch before the node's credential is checked again. */
export const LOG_STREAM_CHECK_MS = 10_000;
/** How long a new stream may wait for its `LogsOpen`. */
export const LOG_STREAM_OPEN_MS = 30_000;

/**
 * The agents' log streams (ADR 0029), one per node: a newer stream of a node replaces the older.
 */
@Injectable()
export class LogStreams {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly batches: LogBatches,
    private readonly authenticate: AuthenticateNode,
  ) {}

  /**
   * `LogsOpen` with the node's current lease epoch, then batches numbered from 1, each acknowledged
   * once stored. The node's credential and lease epoch are checked again before each batch, and
   * every LOG_STREAM_CHECK_MS while none comes: revocation, expiry, removal or a new lease ends
   * the stream. A missing open, a number out of order or a store failure ends it too; the agent
   * sends again from its cursor.
   */
  async *ship(
    requests: AsyncIterable<ShipLogsRequest>,
    context: { readonly signal: AbortSignal },
    node: NodeIdentity,
    timing = { checkMs: LOG_STREAM_CHECK_MS, openWithinMs: LOG_STREAM_OPEN_MS },
  ): AsyncGenerator<ShipLogsResponse> {
    if (!this.batches.accepting)
      throw new ConnectError('logs are not kept', Code.FailedPrecondition);
    const key = `${node.organizationId}/${node.nodeId}`;
    const controller = new AbortController();
    this.active.get(key)?.abort(new ConnectError('log stream replaced', Code.Aborted));
    this.active.set(key, controller);
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const reader = requests[Symbol.asyncIterator]();
    const openBy = Date.now() + timing.openWithinMs;
    let epoch: bigint | undefined;
    let expected = 1n;
    try {
      let pending = nextFrame(reader);
      for (;;) {
        const result = await waitForFrame(pending, signal, timing.checkMs);
        const current = BigInt((await this.authenticate.execute(node)).leaseEpoch);
        if (epoch !== undefined && current !== epoch)
          throw new ConnectError('the lease epoch moved', Code.FailedPrecondition);
        if (result === tick) {
          if (epoch === undefined && Date.now() >= openBy)
            throw new ConnectError('no log stream open', Code.DeadlineExceeded);
          continue;
        }
        if (result.done) return;
        const frame = result.value.frame;
        if (epoch === undefined) {
          if (frame.case !== 'open' || frame.value.leaseEpoch !== current)
            throw new ConnectError('stale or missing log stream open', Code.FailedPrecondition);
          epoch = current;
        } else {
          if (frame.case !== 'batch' || frame.value.seq !== expected)
            throw new ConnectError('log batch out of order', Code.InvalidArgument);
          try {
            await this.batches.deliver(node, frame.value);
          } catch {
            throw new ConnectError('log batch not kept', Code.Unavailable);
          }
          yield create(ShipLogsResponseSchema, {
            frame: { case: 'ack', value: { seq: frame.value.seq } },
          });
          expected++;
        }
        pending = nextFrame(reader);
      }
    } catch (error: unknown) {
      if (error instanceof ConnectError) throw error;
      if (error instanceof NodeAuthenticationError)
        throw new ConnectError('node credentials are no longer valid', Code.Unauthenticated);
      throw new ConnectError('log stream failed', Code.Internal);
    } finally {
      if (this.active.get(key) === controller) this.active.delete(key);
      // Do not await return() on an iterator blocked on a silent peer.
    }
  }
}
