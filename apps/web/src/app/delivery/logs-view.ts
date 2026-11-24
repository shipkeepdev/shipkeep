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
