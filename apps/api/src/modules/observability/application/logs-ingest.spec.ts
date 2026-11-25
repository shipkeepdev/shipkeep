import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { LogBatchSchema, LogEntrySchema, LogStream } from '@shipkeep/proto-ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type LogDelivery, LogBatches } from '../../fleet/application/log-batches';
import { LogsBusyError } from '../../fleet/domain/logs-not-kept';
import { LOG_RATE, type LogRecord, MAX_LOG_WAIT_MS } from '../domain/logs';

import { LogsIngest } from './logs-ingest';
import type { LogsStore, MetricsTargets, MetricsTransaction } from './ports';

const NOW = new Date('2026-11-24T12:00:00Z');
const node = { organizationId: 'o1', nodeId: 'n1', serial: '01' };

/** A delivery whose stream lasts, unless the test ends it. */
function delivery(stillAllowed = () => Promise.resolve()): LogDelivery & { end(): void } {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    stillAllowed,
    end: () => {
      controller.abort(new Error('stream ended'));
    },
  };
}
const kept = delivery();

function world(store: LogsStore | null, sleep?: 'real') {
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
    sleep === 'real' ? undefined : (ms) => (slept.push(ms), Promise.resolve()),
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
    expect(
      world({ write: () => Promise.resolve(), query: () => Promise.resolve([]) }).batches.accepting,
    ).toBe(true);
  });

  it('writes the node lines with the allocation labels, and drops the others', async () => {
    const written: LogRecord[][] = [];
    const w = world({
      write: (records) => (written.push([...records]), Promise.resolve()),
      query: () => Promise.resolve([]),
    });
    await w.ingest.record(
      node,
      batchOf(
        { container: 'sk-web-r1-0', line: 'ready' },
        { container: 'sk-web-r1-0', line: 'oops', stderr: true },
        { container: 'sk-other-r1-0', line: 'not mine' },
        { container: '../etc', line: 'malformed' },
      ),
      kept,
      NOW,
    );
    expect(w.asked).toEqual([['sk-web-r1-0', 'sk-other-r1-0']]);
    expect(written).toEqual([
      [
        {
          _time: '2026-11-24T12:00:00.000000000Z',
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
          _time: '2026-11-24T12:00:00.000000000Z',
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

  it('charges a node in bytes before any lookup, even for lines it drops', async () => {
    const w = world({ write: () => Promise.resolve(), query: () => Promise.resolve([]) });
    // 8192 characters of two bytes each: 16 KiB, for a container that is not the node's.
    const wide = 'é'.repeat(8192);
    for (let i = 0; i < 300; i++)
      await w.ingest.record(node, batchOf({ container: 'sk-other-r1-0', line: wide }), kept, NOW);
    expect(w.slept.length).toBeGreaterThan(0);
  });

  it('drops an entry whose stream is neither stdout nor stderr', async () => {
    const written: LogRecord[][] = [];
    const w = world({
      write: (records) => (written.push([...records]), Promise.resolve()),
      query: () => Promise.resolve([]),
    });
    const batch = batchOf({ container: 'sk-web-r1-0', line: 'kept' });
    batch.entries.push(
      create(LogEntrySchema, {
        container: 'sk-web-r1-0',
        stream: LogStream.UNSPECIFIED,
        time: timestampFromDate(NOW),
        line: 'no stream',
      }),
    );
    await w.ingest.record(node, batch, kept, NOW);
    expect(written.flat().map((record) => record._msg)).toEqual(['kept']);
  });

  it('makes a node past its rate wait before writing, and fails when the store does', async () => {
    const w = world({ write: () => Promise.resolve(), query: () => Promise.resolve([]) });
    const big = 'x'.repeat(16 * 1024);
    for (let i = 0; i < 300; i++)
      await w.ingest.record(node, batchOf({ container: 'sk-web-r1-0', line: big }), kept, NOW);
    expect(w.slept.length).toBeGreaterThan(0);
    const failing = world({
      write: () => Promise.reject(new Error('down')),
      query: () => Promise.resolve([]),
    });
    await expect(
      failing.batches.deliver(node, batchOf({ container: 'sk-web-r1-0', line: 'x' }), kept),
    ).rejects.toThrow();
  });

  describe('when its stream ends or its node may no longer write (#473)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    const big = () => batchOf({ container: 'sk-web-r1-0', line: 'x'.repeat(64 * 1024) });
    /** Spends the node's burst, so that the next batch waits. */
    async function spent(w: ReturnType<typeof world>): Promise<void> {
      for (let i = 0; i < LOG_RATE.burstBytes / (64 * 1024); i++)
        await w.ingest.record(node, big(), kept, NOW);
    }

    it('stops waiting for its quota with its stream, timer cleared, and writes nothing', async () => {
      vi.useFakeTimers();
      const written: LogRecord[][] = [];
      const w = world(
        {
          write: (records) => (written.push([...records]), Promise.resolve()),
          query: () => Promise.resolve([]),
        },
        'real',
      );
      await spent(w);
      const writes = written.length;
      const asked = w.asked.length;
      const stream = delivery();
      const waiting = w.ingest.record(node, big(), stream, NOW);
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1);
      stream.end();
      await expect(waiting).rejects.toThrow('stream ended');
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(MAX_LOG_WAIT_MS);
      expect(written).toHaveLength(writes);
      expect(w.asked).toHaveLength(asked);
    });

    it('checks the node again after a wait, and writes nothing for one no longer allowed', async () => {
      const written: LogRecord[][] = [];
      const w = world({
        write: (records) => (written.push([...records]), Promise.resolve()),
        query: () => Promise.resolve([]),
      });
      await spent(w);
      const writes = written.length;
      const asked = w.asked.length;
      const revoked = delivery(() => Promise.reject(new Error('revoked')));
      await expect(w.ingest.record(node, big(), revoked, NOW)).rejects.toThrow('revoked');
      expect(w.slept.length).toBeGreaterThan(0);
      expect(written).toHaveLength(writes);
      expect(w.asked).toHaveLength(asked);
    });

    it('refuses at once, charging nothing, a batch that would wait too long', async () => {
      vi.useFakeTimers();
      const w = world({ write: () => Promise.resolve(), query: () => Promise.resolve([]) });
      await spent(w);
      // Waits that do not pass, as from streams replaced one after another: the debt grows to
      // its bound, then batches are refused without waiting.
      let refused = 0;
      for (let i = 0; i < 200; i++)
        await w.ingest.record(node, big(), kept, NOW).catch((error: unknown) => {
          if (error instanceof LogsBusyError) refused++;
          else throw error;
        });
      expect(refused).toBeGreaterThan(0);
      expect(Math.max(...w.slept)).toBeLessThanOrEqual(MAX_LOG_WAIT_MS);
      // Nothing refused was charged: once the debt is paid, a batch passes again.
      vi.advanceTimersByTime(MAX_LOG_WAIT_MS + 1000);
      await w.ingest.record(node, big(), kept, NOW);
    });

    it('gives the store its stream, and writes nothing once it ended during the lookup', async () => {
      const signals: (AbortSignal | undefined)[] = [];
      const w = world({
        write: (_records, signal) => (signals.push(signal), Promise.resolve()),
        query: () => Promise.resolve([]),
      });
      const stream = delivery();
      await w.ingest.record(node, batchOf({ container: 'sk-web-r1-0', line: 'a' }), stream, NOW);
      expect(signals).toEqual([stream.signal]);
      const ending = delivery();
      const lookup = w.ingest.record(
        node,
        batchOf({ container: 'sk-web-r1-0', line: 'b' }),
        ending,
        NOW,
      );
      ending.end();
      await expect(lookup).rejects.toThrow('stream ended');
      expect(signals).toHaveLength(1);
    });
  });
});
