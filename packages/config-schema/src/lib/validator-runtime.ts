/** The two helpers the generated validator needs, so Ajv itself stays out of the web bundle. */

/** String length in code points, as JSON Schema's `maxLength` counts it; Ajv's own algorithm. */
export function ucs2length(text: string): number {
  const { length } = text;
  let count = 0;
  let position = 0;
  while (position < length) {
    count++;
    const unit = text.charCodeAt(position++);
    if (unit >= 0xd800 && unit <= 0xdbff && position < length) {
      const next = text.charCodeAt(position);
      if ((next & 0xfc00) === 0xdc00) position++;
    }
  }
  return count;
}

/** Equality of JSON values, for `uniqueItems`, `const` and `enum`. */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || !left || !right) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
    );
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) => Object.hasOwn(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]),
    )
  );
}
