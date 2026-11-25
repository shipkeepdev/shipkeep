import type { LogLine } from './delivery-api';

/** Lines the view keeps; older ones scroll away. */
export const MAX_LINES = 1000;

/** A line's key: the same line can come back when the view asks again from its newest time. */
export function lineKey(line: LogLine): string {
  return `${line.time}|${String(line.instance)}|${line.stream}|${line.line}`;
}

/** The lines shown, newest first: fresh ones on top of the known ones, without repeats. */
export function mergeLines(known: readonly LogLine[], fresh: readonly LogLine[]): LogLine[] {
  const seen = new Set(known.map(lineKey));
  const added = fresh.filter((line) => {
    const key = lineKey(line);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...added, ...known]
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
    .slice(0, MAX_LINES);
}

/** HH:MM:SS of a line, in the viewer's time zone. */
export function clock(time: string): string {
  const at = new Date(time);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * How far before its newest line a live view reads again: lines from several servers reach the
 * store in batches, so one stamped a little earlier may arrive after a later one.
 */
export const OVERLAP_MS = 3000;

/** Where a live read starts: OVERLAP_MS before the newest line shown, repeats merged away. */
export function overlapFrom(newest: string): string {
  return new Date(Date.parse(newest) - OVERLAP_MS).toISOString();
}

/** Pages a live view reads at most on each tick before it waits for the next. */
export const FORWARD_ROUNDS = 5;

/** What a forward read found, and where the next one goes on when it stopped before the end. */
export interface ForwardRead {
  readonly lines: LogLine[];
  /** Set when the last page came back full after FORWARD_ROUNDS: more lines wait from there. */
  readonly resume?: string;
}

/**
 * The lines after `from`, oldest first, read page by page while pages come back full: a burst
 * larger than one page is read whole instead of skipped. A page whose last line is at `from` again
 * ends the reading, so that it always moves forward. When the rounds run out on a full page, the
 * read says where to go on, so the next one does not read the same lines again.
 */
export async function readForward(
  page: (from: string) => Promise<readonly LogLine[]>,
  from: string,
  limit: number,
  rounds = FORWARD_ROUNDS,
): Promise<ForwardRead> {
  const lines: LogLine[] = [];
  let cursor = from;
  for (let round = 0; round < rounds; round++) {
    const answer = await page(cursor);
    lines.push(...answer);
    const last = answer.at(-1);
    if (answer.length < limit || !last || last.time === cursor) return { lines };
    cursor = last.time;
  }
  return { lines, resume: cursor };
}
