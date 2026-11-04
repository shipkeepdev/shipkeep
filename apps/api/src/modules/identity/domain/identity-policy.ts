import { DomainError, InvalidInputError } from '@shipkeep/domain';

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const EMAIL_TOKEN_MS = 24 * 60 * 60 * 1000;
export const RESET_TOKEN_MS = 30 * 60 * 1000;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class AuthenticationError extends DomainError {
  readonly kind = 'unauthorized' as const;
  readonly code = 'authentication_failed';

  constructor() {
    super('Authentication failed.');
  }
}

/** ASCII mailboxes only for v0.1; identity is case-insensitive, matching PostgreSQL citext. */
export function normalizeEmail(input: string): string {
  const email = input.trim().toLowerCase();
  const parts = email.split('@');
  const [local = '', domain = ''] = parts;
  const labels = domain.split('.');
  if (
    input.length > 256 ||
    email.length > 254 ||
    parts.length !== 2 ||
    local.length > 64 ||
    !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local) ||
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    Array.from(input).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new InvalidInputError('invalid_email', 'Enter a valid email address.');
  }
  return email;
}

export function assertPassword(password: string): void {
  const length = Array.from(password).length;
  if (length < 15 || length > 128 || password.includes(String.fromCharCode(0))) {
    throw new InvalidInputError('invalid_password', 'Use between 15 and 128 characters.');
  }
}

export function sessionIsLive(
  session: { createdAt: Date; lastSeenAt: Date; revokedAt: Date | null },
  now: Date,
): boolean {
  const time = now.getTime();
  return (
    session.revokedAt === null &&
    time >= session.createdAt.getTime() &&
    time < session.createdAt.getTime() + SESSION_ABSOLUTE_MS &&
    time < session.lastSeenAt.getTime() + SESSION_IDLE_MS
  );
}
