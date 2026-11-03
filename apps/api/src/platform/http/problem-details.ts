import type { DomainErrorKind } from '@shipkeep/domain';

/** Media type of every error response (RFC 9457). */
export const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/** Base URI of problem types; the error code is appended. */
export const PROBLEM_TYPE_BASE = 'https://shipkeep.dev/problems/';

/** RFC 9457 problem details document, with Shipkeep extensions. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Stable machine-readable code, equal to the last segment of `type`. */
  code: string;
  /** Request id, for support and audit correlation. */
  requestId?: string;
  /** Field-level problems for validation errors. */
  errors?: readonly FieldError[];
  /** Extra structured details safe for the caller. */
  details?: Readonly<Record<string, unknown>>;
}

export interface FieldError {
  /** JSON pointer style path of the offending field, for example `/run/port`. */
  path: string;
  message: string;
}

export function problemType(code: string): string {
  return `${PROBLEM_TYPE_BASE}${code}`;
}

/** HTTP status for each domain error kind. The only place that knows both worlds. */
export const KIND_STATUS: Readonly<Record<DomainErrorKind, number>> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
};

/** Codes used for errors that do not originate in the domain. */
export const PROBLEM_CODES = {
  validationFailed: 'validation_failed',
  notFound: 'not_found',
  internalError: 'internal_error',
  notReady: 'not_ready',
} as const;

const STATUS_TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function statusTitle(status: number): string {
  return STATUS_TITLES[status] ?? 'Error';
}

/** Turns an HTTP status into a generic code such as `not_found` or `too_many_requests`. */
export function statusCode(status: number): string {
  return statusTitle(status)
    .toLowerCase()
    .replace(/[^a-z]+/g, '_');
}
