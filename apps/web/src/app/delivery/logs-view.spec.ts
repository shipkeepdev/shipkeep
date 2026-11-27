import { describe, expect, it } from 'vitest';

import type { BuildLine, LogLine } from './delivery-api';
import {
  lineKey,
  MAX_BUILD_LINES,
  MAX_LINES,
  mergeBuildLines,
  mergeLines,
  overlapFrom,
  readForward,
} from './logs-view';

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
    const { lines, resume } = await readForward(
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
    // It reached the end: the next read starts from the newest line again.
    expect(resume).toBeUndefined();
  });

  it('stops after its rounds, and when a full page does not move', async () => {
    let calls = 0;
    const stopped = await readForward(
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
    // Out of rounds on a full page: the next read goes on from the last line, not from the
    // start again, so more lines than its rounds can hold are read in the end.
    expect(stopped.resume).toBe(at(6));
    calls = 0;
    const still = await readForward(
      () => {
        calls++;
        return Promise.resolve([line(5), line(5)]);
      },
      at(5),
      2,
    );
    expect(calls).toBe(1);
    expect(still.resume).toBeUndefined();
  });
});

describe('where a live read starts', () => {
  it('starts a little before the newest line, so a line another server sent late still shows', () => {
    expect(overlapFrom('2026-11-25T12:00:05.123456789Z')).toBe('2026-11-25T12:00:02.123Z');
  });
});

describe("a build's output (ADR 0032)", () => {
  const built = (nanos: number, text: string): BuildLine => ({
    time: `2026-11-25T12:00:00.${String(nanos).padStart(9, '0')}Z`,
    line: text,
    truncated: false,
  });

  it('keeps the lines oldest first, a line read again once, and equal lines of two times', () => {
    const known = [built(1, 'a'), built(3, 'c')];
    expect(mergeBuildLines(known, [built(3, 'c'), built(2, 'b'), built(4, 'c')])).toEqual({
      lines: [built(1, 'a'), built(2, 'b'), built(3, 'c'), built(4, 'c')],
      dropped: 0,
    });
  });

  it('drops the oldest lines past the bound, and says how many', () => {
    const known = Array.from({ length: MAX_BUILD_LINES }, (_, index) => built(index, 'x'));
    const merged = mergeBuildLines(known, [
      built(MAX_BUILD_LINES, 'y'),
      built(MAX_BUILD_LINES + 1, 'z'),
    ]);
    expect(merged.dropped).toBe(2);
    expect(merged.lines).toHaveLength(MAX_BUILD_LINES);
    expect(merged.lines[0]).toEqual(built(2, 'x'));
    expect(merged.lines.at(-1)).toEqual(built(MAX_BUILD_LINES + 1, 'z'));
  });
});
