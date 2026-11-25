import { create } from '@bufbuild/protobuf';
import { LogBatchSchema } from '@shipkeep/proto-ts';
import { describe, expect, it } from 'vitest';

import { LogsBusyError, LogsNotKeptError } from '../domain/logs-not-kept';

import { LogBatches, MAX_NODE_DELIVERIES } from './log-batches';

const node = { organizationId: 'o1', nodeId: 'n1', serial: '01' };
const open = () => ({
  signal: new AbortController().signal,
  stillAllowed: () => Promise.resolve(),
});

describe('log batches (ADR 0029)', () => {
  it('refuses a batch while no store is registered, then hands it to the store', async () => {
    const batches = new LogBatches();
    const batch = create(LogBatchSchema, { seq: 1n });
    await expect(batches.deliver(node, batch, open())).rejects.toBeInstanceOf(LogsNotKeptError);
    const kept: bigint[] = [];
    batches.register((_identity, value) => (kept.push(value.seq), Promise.resolve()));
    await batches.deliver(node, batch, open());
    expect(kept).toEqual([1n]);
  });

  it('refuses a batch whose stream already ended, unseen by the store', async () => {
    const batches = new LogBatches();
    let seen = 0;
    batches.register(() => (seen++, Promise.resolve()));
    const ended = new AbortController();
    ended.abort(new Error('replaced'));
    await expect(
      batches.deliver(node, create(LogBatchSchema, { seq: 1n }), {
        signal: ended.signal,
        stillAllowed: () => Promise.resolve(),
      }),
    ).rejects.toThrow('replaced');
    expect(seen).toBe(0);
  });

  it('bounds the deliveries under way per node, across its streams (#473)', async () => {
    const batches = new LogBatches();
    const waiting: (() => void)[] = [];
    batches.register(() => new Promise<void>((resolve) => waiting.push(resolve)));
    const batch = create(LogBatchSchema, { seq: 1n });
    const mine = Array.from({ length: MAX_NODE_DELIVERIES }, () =>
      batches.deliver(node, batch, open()),
    );
    // One more for this node, from a new stream or not, is refused at once.
    await expect(batches.deliver(node, batch, open())).rejects.toBeInstanceOf(LogsBusyError);
    // Another node is not held up by this one.
    const other = batches.deliver({ ...node, nodeId: 'n2' }, batch, open());
    for (const release of waiting) release();
    await Promise.all([...mine, other]);
    // Once done, the places are free again.
    const again = batches.deliver(node, batch, open());
    waiting.at(-1)?.();
    await again;
  });
});
