import { create } from '@bufbuild/protobuf';
import { LogBatchSchema } from '@shipkeep/proto-ts';
import { describe, expect, it } from 'vitest';

import { LogsNotKeptError } from '../domain/logs-not-kept';

import { LogBatches } from './log-batches';

const node = { organizationId: 'o1', nodeId: 'n1', serial: '01' };

describe('log batches (ADR 0029)', () => {
  it('refuses a batch while no store is registered, then hands it to the store', async () => {
    const batches = new LogBatches();
    const batch = create(LogBatchSchema, { seq: 1n });
    await expect(batches.deliver(node, batch)).rejects.toBeInstanceOf(LogsNotKeptError);
    const kept: bigint[] = [];
    batches.register((_identity, value) => (kept.push(value.seq), Promise.resolve()));
    await batches.deliver(node, batch);
    expect(kept).toEqual([1n]);
  });
});
