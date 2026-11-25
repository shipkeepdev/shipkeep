import { describe, expect, it } from 'vitest';

import {
  batchBytes,
  ByteRate,
  distinctLines,
  LOG_BATCH_MIN_BYTES,
  LOG_RETENTION_MS,
  type LogInput,
  logLineOf,
  logRecords,
  logsQuery,
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
  nanos: 123_456_789,
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
      entry({ nanos: 1_000_000_000 }),
      entry({ nanos: 1.5 }),
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
        _time: '2026-11-24T11:59:59.123456789Z',
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
        _time: '2026-11-24T11:59:59.123456789Z',
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

  it('replaces a line time too far ahead of the control plane clock', () => {
    const [record] = logRecords(
      [entry({ time: new Date('2030-01-01T00:00:00Z') })],
      [target],
      scope,
      NOW,
    );
    expect(record._time).toBe('2026-11-24T12:00:00.000000000Z');
  });

  it('keeps the time of a line sent again after an outage, and drops one past retention', () => {
    const hourAgo = new Date(NOW.getTime() - 3_600_000);
    const records = logRecords(
      [
        entry({ time: hourAgo }),
        entry({ time: new Date(NOW.getTime() - LOG_RETENTION_MS - 1000), line: 'too old' }),
      ],
      [target],
      scope,
      NOW,
    );
    expect(records.map((record) => [record._time, record._msg])).toEqual([
      ['2026-11-24T11:00:00.123456789Z', 'GET / 200'],
    ]);
  });

  it('charges a batch its lines in UTF-8 bytes, and at least a minimum', () => {
    expect(batchBytes(['é'.repeat(20_000), 'abc'])).toBe(40_003);
    expect(batchBytes([])).toBe(LOG_BATCH_MIN_BYTES);
    expect(batchBytes(['x'])).toBe(LOG_BATCH_MIN_BYTES);
  });

  it('says when a bucket has refilled, so that it can be forgotten', () => {
    const rate = new ByteRate(1000, 4000, 0);
    rate.take(4000, 0);
    expect(rate.full(1000)).toBe(false);
    expect(rate.full(4000)).toBe(true);
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

describe('log searches (ADR 0029)', () => {
  const search = {
    organizationId: '019d0000-0000-7000-8000-00000000000a',
    applicationId: '019d0000-0000-7000-8000-0000000000a1',
    text: '',
    from: new Date('2026-11-24T11:00:00Z'),
    to: new Date('2026-11-24T12:00:00Z'),
    limit: 200,
  };

  it('filters on the labels the control plane wrote, newest first', () => {
    expect(logsQuery({ ...search, stream: 'stderr', instance: 2, text: 'timeout' })).toBe(
      '{org="019d0000-0000-7000-8000-00000000000a",app="019d0000-0000-7000-8000-0000000000a1"} ' +
        '_time:[2026-11-24T11:00:00.000Z, 2026-11-24T12:00:00.000Z] stream:=stderr instance:="2" *"timeout"* ' +
        '| sort by (_time desc) | limit 200',
    );
  });

  it('starts at the exact time a live view gives, to the nanosecond, and at nothing else', () => {
    expect(logsQuery({ ...search, fromExact: '2026-11-24T11:00:00.123456789Z' })).toContain(
      '_time:[2026-11-24T11:00:00.123456789Z, 2026-11-24T12:00:00.000Z]',
    );
    for (const fromExact of ['2026-11-24T11:00:00+01:00', '2026-11-24T11:00:00.1234567890Z', 'x'])
      expect(logsQuery({ ...search, fromExact })).toContain('_time:[2026-11-24T11:00:00.000Z,');
  });

  it('reads forward from a time for a live view, so that nothing between two reads is missed', () => {
    expect(logsQuery({ ...search, order: 'oldest' })).toMatch(
      / \| sort by \(_time\) \| limit 200$/,
    );
  });

  it('keeps the text one quoted substring, whatever it holds', () => {
    for (const [text, phrase] of [
      ['" | delete', '"\\" | delete"'],
      ['a\\" OR app:*', '"a\\\\\\" OR app:*"'],
      ['line\nbreak\u0000', '"line break "'],
      ['} {org="other"}', '"} {org=\\"other\\"}"'],
    ] as const) {
      const query = logsQuery({ ...search, text });
      expect(query).toContain(` *${phrase}* | sort`);
      expect(query.startsWith('{org="019d0000-0000-7000-8000-00000000000a",')).toBe(true);
    }
  });

  it('refuses a scope that is not two identifiers', () => {
    expect(() => logsQuery({ ...search, applicationId: 'x"} OR {app=*' })).toThrow();
  });

  it('reads back only the lines Shipkeep wrote', () => {
    expect(
      logLineOf({
        _time: '2026-11-24T11:30:00.97Z',
        _msg: 'ready',
        stream: 'stdout',
        instance: '1',
      }),
    ).toEqual({
      // VictoriaLogs trims trailing zeros; the API answers nine digits, so times sort as text.
      time: '2026-11-24T11:30:00.970000000Z',
      stream: 'stdout',
      instance: 1,
      line: 'ready',
      truncated: false,
    });
    expect(
      logLineOf({
        _time: '2026-11-24T11:30:00Z',
        _msg: 'cut',
        stream: 'stderr',
        instance: '3',
        truncated: 'true',
      })?.truncated,
    ).toBe(true);
    for (const record of [
      null,
      'x',
      {},
      { _time: '2026-11-24T11:30:00Z', _msg: 'm', stream: 'other', instance: '1' },
      { _time: '2026-11-24T11:30:00Z', _msg: 'm', stream: 'stdout', instance: 'x' },
      { _time: '2026-11-24T11:30:00Z', _msg: 'm', stream: 'stdout', instance: '' },
      { _time: '2026-11-24T11:30:00Z', _msg: 'm', stream: 'stdout', instance: null },
      { _time: '2026-11-24T11:30:00Z', _msg: 'm', stream: 'stdout', instance: '1e2' },
      { _time: 't', _msg: 'm', stream: 'stdout', instance: '1' },
    ])
      expect(logLineOf(record)).toBeUndefined();
  });

  it('shows once a line the agent sent again after an outage', () => {
    const line = {
      time: '2026-11-24T22:20:28.073Z',
      stream: 'stdout' as const,
      instance: 0,
      line: 'GET / 200',
      truncated: false,
    };
    const other = { ...line, stream: 'stderr' as const };
    const later = { ...line, time: '2026-11-24T22:20:29.000Z' };
    expect(distinctLines([later, line, line, other, line])).toEqual([later, line, other]);
  });
});
