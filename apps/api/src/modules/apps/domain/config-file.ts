import { ConflictError, DomainError, InvalidInputError } from '@shipkeep/domain';
import { type Document, isAlias, isMap, isPair, isScalar, isSeq, parseDocument, visit } from 'yaml';

import { canonicalJson } from './application';

/**
 * Writing a Git application's shipkeep.yml back from the interface (#214, ADR 0031). Pure: the
 * caller reads the file and writes the text this answers.
 */

/** The file changed in the repository since a change was prepared against it. */
export function configFileChanged(): ConflictError {
  return new ConflictError(
    'config_file_changed',
    'The file changed in the repository since it was read: review the change again.',
  );
}

/**
 * A change written to its repository whose audit event could not be recorded: the command fails,
 * as any whose audit fails. Sent again, the change is found where it was written, not written
 * twice, and recorded then (#214).
 */
export class ConfigWrittenUnrecordedError extends DomainError {
  readonly kind = 'unavailable' as const;
  readonly code = 'config_written_unrecorded';

  constructor() {
    super(
      'The change was written to the repository, but could not be recorded: send it again, it is not written twice.',
    );
  }
}

/** Lines kept around each change in a diff. */
const CONTEXT = 3;
/** The largest middle a diff aligns line by line; a longer one is shown removed, then added. */
const MAX_ALIGNED_CELLS = 250_000;

/**
 * The text of `original` holding `document` instead, changed as little as can be: a value edited
 * keeps its node, and so its comment; a key added goes at the end of its map; a key gone is
 * removed; a list that changed is written again whole. Comments, key order and blank lines stay
 * elsewhere. Refuses a file that is not a YAML map, or has duplicate keys.
 */
export function rewriteConfigFile(original: string, document: object): string {
  const file = parseDocument(original, { uniqueKeys: true, prettyErrors: false });
  const refused = () =>
    new InvalidInputError(
      'invalid_config_file',
      'The file in the repository is not a YAML map: fix it in the repository first.',
    );
  if (file.errors.length > 0 || !isMap(file.contents)) throw refused();
  let current: unknown;
  try {
    current = file.toJS();
  } catch {
    // An alias to an anchor the file does not define fails only here.
    throw refused();
  }
  // Nothing changes: the file stays as it is, spacing included.
  if (canonicalJson(current) === canonicalJson(document)) return original;
  patch({ file, after: document, aliases: aliasPaths(file) }, [], current, document);
  // No folding: a long value stays on its line, as the file has it. Its line breaks stay too:
  // CRLF when it has them, and no final one when it has none.
  let text = file.toString({ lineWidth: 0 });
  if (!original.endsWith('\n')) text = text.replace(/\n$/, '');
  if (original.includes('\r\n')) text = text.replace(/\r?\n/g, '\r\n');
  // What is written must read back as the document, whatever the edit did.
  if (canonicalJson(parseDocument(text).toJS()) !== canonicalJson(document))
    throw new InvalidInputError(
      'invalid_config_file',
      'This change cannot be written into the file as it is: change it in the repository.',
    );
  return text;
}

interface Patching {
  readonly file: Document;
  /** The whole document asked for. */
  readonly after: object;
  /** The key paths of the aliases in maps, by the anchor they name. */
  readonly aliases: ReadonlyMap<string, readonly (readonly string[])[]>;
}

function patch(at: Patching, path: readonly string[], before: unknown, after: unknown): void {
  if (!plain(before) || !plain(after)) return;
  // Own keys only: a key such as `constructor` is not one an object inherits.
  for (const key of Object.keys(before)) if (!own(after, key)) at.file.deleteIn([...path, key]);
  for (const [key, value] of Object.entries(after)) {
    const keyPath = [...path, key];
    const old = before[key];
    if (own(before, key) && canonicalJson(old) === canonicalJson(value)) continue;
    if (plain(old) && plain(value)) {
      patch(at, keyPath, old, value);
      continue;
    }
    const node = at.file.getIn(keyPath, true);
    // An alias whose anchor now holds the value asked for stays an alias.
    if (isAlias(node)) {
      const target = node.resolve(at.file);
      if (isScalar(target) && canonicalJson(target.value) === canonicalJson(value)) continue;
    }
    // A scalar keeps its node, with the comment on its line.
    if (isScalar(node) && value !== null && typeof value !== 'object') {
      if (node.anchor) detach(at, node.anchor, value);
      node.value = value;
    } else at.file.setIn(keyPath, value);
  }
}

/**
 * Before an anchored scalar takes `value`, each alias of it asked to hold something else is written
 * as that value instead: otherwise it would follow the anchor. An alias asked to hold `value` too
 * stays an alias. An anchored list or map that changes is left to the check that the text reads
 * back as the document.
 */
function detach(at: Patching, anchor: string, value: unknown): void {
  for (const path of at.aliases.get(anchor) ?? []) {
    const wanted = valueAt(at.after, path);
    if (wanted !== undefined && canonicalJson(wanted) !== canonicalJson(value))
      at.file.setIn(path, wanted);
  }
}

/** The key paths of the file's aliases that sit in maps only, by anchor. */
function aliasPaths(file: Document): Map<string, string[][]> {
  const found = new Map<string, string[][]>();
  visit(file, {
    Alias(_key, node, ancestors) {
      if (ancestors.some((ancestor) => isSeq(ancestor))) return;
      const path: string[] = [];
      for (const ancestor of ancestors)
        if (isPair(ancestor) && isScalar(ancestor.key)) path.push(String(ancestor.key.value));
      found.set(node.source, [...(found.get(node.source) ?? []), path]);
    },
  });
  return found;
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let at = value;
  for (const key of path) {
    if (!plain(at) || !own(at, key)) return undefined;
    at = at[key];
  }
  return at;
}

function own(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A line of a diff, or a run of unchanged lines left out. */
export type DiffLine =
  | { readonly kind: 'same' | 'removed' | 'added'; readonly text: string }
  | { readonly kind: 'skipped'; readonly count: number };

/**
 * The lines `after` changes in `before`, with three unchanged lines around each change; longer
 * unchanged runs are counted, not shown. Nothing for equal texts.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const middle = align(a.slice(start, a.length - end), b.slice(start, b.length - end));
  if (!middle.some((line) => line.kind !== 'same')) return [];
  const all: { kind: 'same' | 'removed' | 'added'; text: string }[] = [
    ...a.slice(0, start).map((text) => ({ kind: 'same' as const, text })),
    ...middle,
    ...a.slice(a.length - end).map((text) => ({ kind: 'same' as const, text })),
  ];
  return hunks(all);
}

function lines(text: string): string[] {
  const split = text.split(/\r?\n/);
  // A final line break ends the last line; it does not start another.
  if (split.at(-1) === '') split.pop();
  return split;
}

/** Aligns two runs of lines on their longest common subsequence, when that stays small. */
function align(
  a: readonly string[],
  b: readonly string[],
): { kind: 'same' | 'removed' | 'added'; text: string }[] {
  if (a.length * b.length > MAX_ALIGNED_CELLS)
    return [
      ...a.map((text) => ({ kind: 'removed' as const, text })),
      ...b.map((text) => ({ kind: 'added' as const, text })),
    ];
  const width = b.length + 1;
  // common[i * width + j]: the longest common subsequence of a[i..] and b[j..]. Every index stays
  // within the table: i <= a.length and j <= b.length.
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      common[i * width + j] =
        a[i] === b[j]
          ? common[(i + 1) * width + j + 1] + 1
          : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
  const out: { kind: 'same' | 'removed' | 'added'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (
      i < a.length &&
      (j >= b.length || common[(i + 1) * width + j] >= common[i * width + j + 1])
    ) {
      out.push({ kind: 'removed', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'added', text: b[j] });
      j++;
    }
  }
  return out;
}

/** Keeps the changed lines and three unchanged ones around each; counts the others. */
function hunks(all: readonly { kind: 'same' | 'removed' | 'added'; text: string }[]): DiffLine[] {
  const near = all.map((line, index) =>
    all
      .slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1)
      .some((other) => other.kind !== 'same'),
  );
  const out: DiffLine[] = [];
  let skipped = 0;
  all.forEach((line, index) => {
    if (line.kind !== 'same' || near[index]) {
      if (skipped) out.push({ kind: 'skipped', count: skipped });
      skipped = 0;
      out.push(line);
    } else skipped++;
  });
  if (skipped) out.push({ kind: 'skipped', count: skipped });
  return out;
}
