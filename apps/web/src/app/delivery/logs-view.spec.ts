import { describe, expect, it } from 'vitest';

import type { LogLine } from './delivery-api';
import { lineKey, MAX_LINES, mergeLines, readForward } from './logs-view';

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

describe('reading a live view forward', () => {
  const at = (i: number) => `2026-11-25T12:00:${String(i).padStart(2, '0')}.000000000Z`;
  const line = (i: number) => ({
    time: at(i),
    stream: 'stdout' as const,
    instance: 0,
    line: `l${String(i)}`,
    truncated: false,
  });

  it('reads page after page while they come back full, from the last line read', async () => {
    const asked: string[] = [];
    const lines = await readForward(
      (from) => {
        asked.push(from);
        const start = Number(from.slice(17, 19));
        // Pages of 3 until line 7.
        return Promise.resolve(
          [start, start + 1, start + 2].filter((i) => i <= 7).map((i) => line(i)),
        );
      },
      at(1),
      3,
    );
    expect(asked).toEqual([at(1), at(3), at(5), at(7)]);
    expect(lines.map((l) => l.line)).toEqual([
      'l1',
      'l2',
      'l3',
      'l3',
      'l4',
      'l5',
      'l5',
      'l6',
      'l7',
      'l7',
    ]);
  });

  it('stops after its rounds, and when a full page does not move', async () => {
    let calls = 0;
    await readForward(
      (from) => {
        calls++;
        const start = Number(from.slice(17, 19));
        return Promise.resolve([line(start + 1), line(start + 2)]);
      },
      at(0),
      2,
      3,
    );
    expect(calls).toBe(3);
    calls = 0;
    await readForward(
      () => {
        calls++;
        return Promise.resolve([line(5), line(5)]);
      },
      at(5),
      2,
    );
    expect(calls).toBe(1);
  });
});
