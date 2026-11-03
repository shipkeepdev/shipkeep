/**
 * Classification of a domain error. The interface layer maps each kind to an HTTP status; the
 * domain itself knows nothing about HTTP.
 */
export type DomainErrorKind =
  'invalid' | 'not_found' | 'conflict' | 'forbidden' | 'unauthorized' | 'precondition_failed';

/**
 * Base class for typed domain errors. `code` is a stable machine-readable identifier
 * (`snake_case`, for example `application_name_taken`) that becomes the problem `type` suffix
 * in API responses. Messages must never contain secrets (CLAUDE.md, rule 8).
 */
export abstract class DomainError extends Error {
  abstract readonly kind: DomainErrorKind;
  abstract readonly code: string;

  /** Optional structured details safe to show to the caller. */
  readonly details?: Readonly<Record<string, unknown>>;

  protected constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = new.target.name;
    if (details !== undefined) this.details = details;
  }
}

/** Type guard for any domain error. */
export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/** Raised when an input violates a domain invariant. */
export class InvalidInputError extends DomainError {
  readonly kind = 'invalid' as const;
  readonly code: string;

  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, details);
    this.code = code;
  }
}

/** Raised when a referenced resource does not exist or is not visible to the caller. */
export class NotFoundError extends DomainError {
  readonly kind = 'not_found' as const;
  readonly code: string;

  constructor(resource: string, details?: Readonly<Record<string, unknown>>) {
    super(`${resource} not found`, details);
    this.code = `${resource}_not_found`;
  }
}

/** Raised when a change conflicts with the current state (duplicate name, stale version). */
export class ConflictError extends DomainError {
  readonly kind = 'conflict' as const;
  readonly code: string;

  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message, details);
    this.code = code;
  }
}
