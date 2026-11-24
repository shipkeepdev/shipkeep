import { describe, expect, it } from 'vitest';

import type { LogLine } from './delivery-api';
import { lineKey, MAX_LINES, mergeLines } from './logs-view';

const line = (time: string, text: string, instance = 1): LogLine => ({
  time,
  stream: 'stdout',
  instance,
  line: text,
  truncated: false,
});

describe('the logs view', () => {
  it('puts fresh lines on top, newest first, without the ones it has already', () => {
    const known = [line('2026-11-24T12:00:02Z', 'b'), line('2026-11-24T12:00:01Z', 'a')];
    // Asking again from the newest time brings it back.
    const fresh = [line('2026-11-24T12:00:03Z', 'c'), line('2026-11-24T12:00:02Z', 'b')];
    expect(mergeLines(known, fresh).map((l) => l.line)).toEqual(['c', 'b', 'a']);
  });

  it('tells apart lines of the same time from two replicas', () => {
    const a = line('2026-11-24T12:00:00Z', 'ready', 1);
    const b = line('2026-11-24T12:00:00Z', 'ready', 2);
    expect(lineKey(a)).not.toBe(lineKey(b));
    expect(mergeLines([a], [b])).toHaveLength(2);
  });

  it('keeps the newest lines only', () => {
    const many = Array.from({ length: MAX_LINES + 50 }, (_, i) =>
      line(new Date(Date.UTC(2026, 10, 24, 12, 0, i)).toISOString(), String(i)),
    );
    const merged = mergeLines([], many);
    expect(merged).toHaveLength(MAX_LINES);
    expect(merged[0]?.line).toBe(String(MAX_LINES + 49));
  });
});
