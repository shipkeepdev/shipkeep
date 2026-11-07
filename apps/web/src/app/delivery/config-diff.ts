import { shipkeepSchema } from '@shipkeep/config-schema';
import { stringify } from 'yaml';

const KEY_ORDER: readonly string[] = Object.keys(shipkeepSchema.properties);

/**
 * YAML in the order `shipkeep.yml` is documented. The database does not keep key order, which
 * would otherwise show `run` before `name` and `version`, and diff unrelated lines.
 */
export function configYaml(config: object): string {
  const entries = Object.entries(config);
  const rank = (key: string): number => {
    const index = KEY_ORDER.indexOf(key);
    return index < 0 ? KEY_ORDER.length : index;
  };
  return stringify(Object.fromEntries(entries.sort(([left], [right]) => rank(left) - rank(right))));
}

/** Changed YAML lines between two configurations, with up to three lines of context. */
export function configDiff(previous: object, next: object): string[] {
  const before = configYaml(previous).trimEnd().split('\n');
  const after = configYaml(next).trimEnd().split('\n');
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
