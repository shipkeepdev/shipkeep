import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { LogBatchSchema, LogStream } from '@shipkeep/proto-ts';
import { describe, expect, it } from 'vitest';

import { LogBatches } from '../../fleet/application/log-batches';
import type { LogRecord } from '../domain/logs';

import { LogsIngest } from './logs-ingest';
import type { LogsStore, MetricsTargets, MetricsTransaction } from './ports';

const NOW = new Date('2026-11-24T12:00:00Z');
const node = { organizationId: 'o1', nodeId: 'n1', serial: '01' };

function world(store: LogsStore | null) {
  const batches = new LogBatches();
  const asked: string[][] = [];
  const slept: number[] = [];
  const targets = {
    onNode: (_org: string, _node: string, containers: readonly string[]) => {
      asked.push([...containers]);
      return Promise.resolve({
        containers: [
          {
            container: 'sk-web-r1-0',
            replica: 2,
            projectId: 'p',
            environmentId: 'e',
            applicationId: 'a',
          },
        ],
        hosts: [],
      });
    },
  } as unknown as MetricsTargets;
  const transaction = {
    runTenant: (_o: string, work: () => Promise<unknown>) => work(),
  } as MetricsTransaction;
  const ingest = new LogsIngest(
    batches,
    targets,
    transaction,
    store,
    (ms) => (slept.push(ms), Promise.resolve()),
  );
  ingest.onModuleInit();
  return { batches, ingest, asked, slept };
}

const batchOf = (...lines: { container: string; line: string; stderr?: boolean }[]) =>
  create(LogBatchSchema, {
    seq: 1n,
    entries: lines.map((item) => ({
      container: item.container,
      stream: item.stderr ? LogStream.STDERR : LogStream.STDOUT,
      time: timestampFromDate(NOW),
      line: item.line,
    })),
  });

describe('log ingestion (ADR 0029)', () => {
  it('registers only with a store', () => {
    expect(world(null).batches.accepting).toBe(false);
    expect(world({ write: () => Promise.resolve() }).batches.accepting).toBe(true);
  });

  it('writes the node lines with the allocation labels, and drops the others', async () => {
    const written: LogRecord[][] = [];
    const w = world({ write: (records) => (written.push([...records]), Promise.resolve()) });
    await w.ingest.record(
      node,
      batchOf(
        { container: 'sk-web-r1-0', line: 'ready' },
        { container: 'sk-web-r1-0', line: 'oops', stderr: true },
        { container: 'sk-other-r1-0', line: 'not mine' },
        { container: '../etc', line: 'malformed' },
      ),
      NOW,
    );
    expect(w.asked).toEqual([['sk-web-r1-0', 'sk-other-r1-0']]);
    expect(written).toEqual([
      [
        {
          _time: NOW.toISOString(),
          _msg: 'ready',
          org: 'o1',
          project: 'p',
          env: 'e',
          app: 'a',
          instance: '2',
          node: 'n1',
          stream: 'stdout',
        },
        {
          _time: NOW.toISOString(),
          _msg: 'oops',
          org: 'o1',
          project: 'p',
          env: 'e',
          app: 'a',
          instance: '2',
          node: 'n1',
          stream: 'stderr',
        },
      ],
    ]);
  });

  it('makes a node past its rate wait before writing, and fails when the store does', async () => {
    const w = world({ write: () => Promise.resolve() });
    const big = 'x'.repeat(16 * 1024);
    for (let i = 0; i < 300; i++)
      await w.ingest.record(node, batchOf({ container: 'sk-web-r1-0', line: big }), NOW);
    expect(w.slept.length).toBeGreaterThan(0);
    const failing = world({ write: () => Promise.reject(new Error('down')) });
    await expect(
      failing.batches.deliver(node, batchOf({ container: 'sk-web-r1-0', line: 'x' })),
    ).rejects.toThrow();
  });
});
