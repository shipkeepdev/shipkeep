import { stringify } from 'yaml';

/** Changed YAML lines between two configurations, with up to three lines of context. */
export function configDiff(previous: object, next: object): string[] {
  const before = stringify(previous).trimEnd().split('\n');
  const after = stringify(next).trimEnd().split('\n');
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - end - 1] === after[after.length - end - 1]
  )
    end++;
  if (start === before.length && start === after.length) return [];
  return [
    ...before.slice(Math.max(0, start - 3), start).map((line) => `  ${line}`),
    ...before.slice(start, before.length - end).map((line) => `- ${line}`),
    ...after.slice(start, after.length - end).map((line) => `+ ${line}`),
    ...after.slice(after.length - end, after.length - end + 3).map((line) => `  ${line}`),
  ];
}
