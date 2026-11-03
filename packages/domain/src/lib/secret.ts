/** What every secret renders as outside of `expose()`. */
export const REDACTED = '[REDACTED]';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * Wrapper for a sensitive value (token, password, key material). It redacts itself whenever it
 * is stringified, JSON-serialized, template-interpolated or inspected, so the value can only
 * leave through an explicit `expose()` call at the point of use (CLAUDE.md, rule 8).
 */
export class Secret<T = string> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /** Returns the raw value. Call it only where the value is consumed, never to log or store it. */
  expose(): T {
    return this.#value;
  }

  /** Constant-time comparison for string secrets; reference equality otherwise. */
  equals(other: Secret<T>): boolean {
    const a = this.#value;
    const b = other.#value;
    if (typeof a === 'string' && typeof b === 'string') {
      return constantTimeEqual(a, b);
    }
    return a === b;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return `Secret(${REDACTED})`;
  }

  get [Symbol.toStringTag](): string {
    return 'Secret';
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
