import { describe, expect, it } from 'vitest';

import {
  ByteRate,
  type LogInput,
  logRecords,
  MAX_LOG_ENTRIES,
  MAX_LOG_LINE_BYTES,
  validEntries,
} from './logs';
import type { ContainerTarget } from './metrics';

const NOW = new Date('2026-11-24T12:00:00Z');
const entry = (overrides: Partial<LogInput> = {}): LogInput => ({
  container: 'sk-web-r1-0',
  stream: 'stdout',
  time: new Date('2026-11-24T11:59:59Z'),
  line: 'GET / 200',
  truncated: false,
  ...overrides,
});
const target: ContainerTarget = {
  container: 'sk-web-r1-0',
  replica: 1,
  projectId: 'p1',
  environmentId: 'e1',
  applicationId: 'a1',
};
const scope = { organizationId: 'o1', nodeId: 'n1' };

describe('log batches (ADR 0029)', () => {
  it('keeps well-formed entries within the bounds', () => {
    expect(validEntries([entry()])).toHaveLength(1);
    for (const bad of [
      entry({ container: '../../x' }),
      entry({ container: 'SK-WEB' }),
      entry({ container: `sk-${'a'.repeat(61)}` }),
      entry({ time: new Date(Number.NaN) }),
      entry({ line: 'é'.repeat(MAX_LOG_LINE_BYTES / 2 + 1) }),
    ])
      expect(validEntries([bad])).toEqual([]);
    expect(validEntries(Array.from({ length: MAX_LOG_ENTRIES + 10 }, () => entry()))).toHaveLength(
      MAX_LOG_ENTRIES,
    );
  });

  it('labels lines from the node allocation, never from the agent, and drops the others', () => {
    const records = logRecords(
      [
        entry(),
        entry({ container: 'sk-other-r1-0' }),
        entry({ stream: 'stderr', truncated: true }),
      ],
      [target],
      scope,
      NOW,
    );
    expect(records).toEqual([
      {
        _time: '2026-11-24T11:59:59.000Z',
        _msg: 'GET / 200',
        org: 'o1',
        project: 'p1',
        env: 'e1',
        app: 'a1',
        instance: '1',
        node: 'n1',
        stream: 'stdout',
      },
      {
        _time: '2026-11-24T11:59:59.000Z',
        _msg: 'GET / 200',
        org: 'o1',
        project: 'p1',
        env: 'e1',
        app: 'a1',
        instance: '1',
        node: 'n1',
        stream: 'stderr',
        truncated: true,
      },
    ]);
    expect(JSON.stringify(records)).not.toContain('sk-web');
  });

  it('replaces a line time too far from the control plane clock', () => {
    const [record] = logRecords(
      [entry({ time: new Date('2030-01-01T00:00:00Z') })],
      [target],
      scope,
      NOW,
    );
    expect(record._time).toBe(NOW.toISOString());
  });

  it('lets a node write its burst at once, then its rate', () => {
    const rate = new ByteRate(1000, 4000, 0);
    expect(rate.take(4000, 0)).toBe(0);
    expect(rate.take(1000, 0)).toBe(1000);
    // Two seconds later, one was paid back for the waiting write, one is free.
    expect(rate.take(1000, 2000)).toBe(0);
    expect(rate.take(10_000, 2000)).toBe(10_000);
  });
});
