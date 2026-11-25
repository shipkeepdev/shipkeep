import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  type ShipLogsRequest,
  ShipLogsRequestSchema,
  type ShipLogsResponse,
} from '@shipkeep/proto-ts';
import { describe, expect, it } from 'vitest';

import { AuthenticateNode } from '../application/authenticate-node';
import { LogBatches, MAX_NODE_DELIVERIES } from '../application/log-batches';
import type { NodeCredential } from '../domain/node-identity';

import { LogStreams } from './log-stream';

const node = { organizationId: 'o1', nodeId: 'n1', serial: '01' };
const open = (epoch: bigint) =>
  create(ShipLogsRequestSchema, { frame: { case: 'open', value: { leaseEpoch: epoch } } });
const batch = (seq: bigint) =>
  create(ShipLogsRequestSchema, { frame: { case: 'batch', value: { seq, entries: [] } } });
const fast = { checkMs: 5, openWithinMs: 50 };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The node's credential as the store holds it; tests change it while a stream runs. */
function credential(): NodeCredential {
  return {
    ...node,
    status: 'enrolling',
    leaseEpoch: 3,
    notBefore: new Date(Date.now() - 1000),
    notAfter: new Date(Date.now() + 60_000),
    revokedAt: null,
  };
}

function streams(batches: LogBatches, stored = credential()): LogStreams {
  const authenticate = new AuthenticateNode({
    find: () => Promise.resolve(stored),
    replace: () => Promise.resolve(false),
  });
  return new LogStreams(batches, authenticate);
}

async function* frames(...items: ShipLogsRequest[]): AsyncGenerator<ShipLogsRequest> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}

/** Frames, then silence: the peer keeps the stream open without sending. */
async function* thenSilent(...items: ShipLogsRequest[]): AsyncGenerator<ShipLogsRequest> {
  yield* frames(...items);
  await new Promise(() => undefined);
}

async function drain(
  stream: AsyncGenerator<ShipLogsResponse>,
): Promise<{ acks: bigint[]; code?: Code }> {
  const acks: bigint[] = [];
  try {
    for await (const response of stream)
      if (response.frame.case === 'ack') acks.push(response.frame.value.seq);
  } catch (error) {
    return { acks, code: error instanceof ConnectError ? error.code : Code.Unknown };
  }
  return { acks };
}

const signal = new AbortController().signal;

function run(batches: LogBatches, ...items: ShipLogsRequest[]) {
  return drain(streams(batches).ship(frames(...items), { signal }, node, fast));
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

  it('ends a silent stream once the node is revoked or its lease moves', async () => {
    const revoked = credential();
    const relay = streams(accepting().batches, revoked);
    const ended = drain(relay.ship(thenSilent(open(3n), batch(1n)), { signal }, node, fast));
    await pause(20);
    revoked.revokedAt = new Date();
    expect(await ended).toEqual({ acks: [1n], code: Code.Unauthenticated });

    const moved = credential();
    const failover = streams(accepting().batches, moved);
    const stale = drain(failover.ship(thenSilent(open(3n)), { signal }, node, fast));
    await pause(20);
    moved.leaseEpoch = 4;
    expect((await stale).code).toBe(Code.FailedPrecondition);
  });

  it('keeps one stream per node, and drops a peer that never opens', async () => {
    const relay = streams(accepting().batches);
    const first = drain(relay.ship(thenSilent(open(3n)), { signal }, node, fast));
    await pause(20);
    const second = drain(relay.ship(thenSilent(open(3n)), { signal }, node, fast));
    expect((await first).code).toBe(Code.Aborted);
    const silent = drain(relay.ship(thenSilent(), { signal }, node, fast));
    expect((await silent).code).toBe(Code.DeadlineExceeded);
    // The silent one replaced the second in turn.
    expect((await second).code).toBe(Code.Aborted);
  });

  describe('deliveries under way when a stream ends (#473)', () => {
    /**
     * A store whose writes wait a second for their quota, as a node past its rate does, unless
     * their stream ends first: each wait is counted while it lasts, and each write done.
     */
    function blocking() {
      const batches = new LogBatches();
      const state = { waiting: 0, most: 0, written: 0 };
      batches.register(
        (_identity, _batch, delivery) =>
          new Promise<void>((resolve, reject) => {
            state.waiting++;
            state.most = Math.max(state.most, state.waiting);
            const quota = setTimeout(() => {
              state.waiting--;
              state.written++;
              resolve();
            }, 1000);
            delivery.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(quota);
                state.waiting--;
                reject(new Error('cancelled'));
              },
              { once: true },
            );
          }),
      );
      return { batches, state };
    }

    it('cancels the batch of a replaced stream, and keeps the work of one node bounded', async () => {
      const { batches, state } = blocking();
      const relay = streams(batches);
      const ended: Promise<{ acks: bigint[]; code?: Code }>[] = [];
      // A node that opens a new stream again and again, each with a batch held by its quota.
      for (let i = 0; i < 20; i++) {
        ended.push(drain(relay.ship(thenSilent(open(3n), batch(1n)), { signal }, node, fast)));
        await pause(5);
      }
      const results = await Promise.all(ended.slice(0, -1));
      for (const result of results) expect(result).toEqual({ acks: [], code: Code.Aborted });
      expect(state.waiting).toBe(1);
      expect(state.most).toBeLessThanOrEqual(MAX_NODE_DELIVERIES);
      expect(state.written).toBe(0);
      relay.onApplicationShutdown();
      expect(await ended.at(-1)).toEqual({ acks: [], code: Code.Unavailable });
      expect(state.waiting).toBe(0);
    });

    it('acknowledges nothing a stream cancelled during its write kept', async () => {
      const batches = new LogBatches();
      const cancelled = new AbortController();
      batches.register(() => {
        // The write completes, but the transport went away meanwhile.
        cancelled.abort(new Error('transport closed'));
        return Promise.resolve();
      });
      const result = await drain(
        streams(batches).ship(
          thenSilent(open(3n), batch(1n)),
          { signal: cancelled.signal },
          node,
          fast,
        ),
      );
      expect(result).toEqual({ acks: [], code: Code.Canceled });
    });

    it('writes nothing for a node revoked while its batch waited', async () => {
      const revoked = credential();
      const batches = new LogBatches();
      let written = 0;
      batches.register(async (_identity, _batch, delivery) => {
        revoked.revokedAt = new Date();
        await delivery.stillAllowed();
        written++;
      });
      const result = await drain(
        streams(batches, revoked).ship(thenSilent(open(3n), batch(1n)), { signal }, node, fast),
      );
      expect(result).toEqual({ acks: [], code: Code.Unauthenticated });
      expect(written).toBe(0);
    });
  });
});
