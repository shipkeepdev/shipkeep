import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { InvalidInputError } from '@shipkeep/domain';

/** Lifetime of a join token (SPEC section 3.2). */
export const JOIN_TOKEN_TTL_MS = 15 * 60 * 1000;
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Plain join token as shown once to the operator. Never stored. */
export interface IssuedJoinToken {
  readonly id: string;
  /** base64url of 32 random bytes. */
  readonly value: string;
  readonly expiresAt: Date;
}

/** Stored join token: only the SHA-256 of the value is kept. */
export interface JoinTokenRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly tokenHash: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly usedByNodeId: string | null;
}

export function generateJoinTokenValue(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashJoinToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Syntactic check before any lookup, so malformed input never reaches the database. */
export function isWellFormedJoinToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export type JoinTokenRejection = 'malformed' | 'unknown' | 'expired' | 'used';

/**
 * Decides whether a presented token may enroll a node. Pure: the caller looks the record up by
 * hash and passes `now`.
 */
export function evaluateJoinToken(
  presented: string,
  record: JoinTokenRecord | undefined,
  now: Date,
): { ok: true; record: JoinTokenRecord } | { ok: false; reason: JoinTokenRejection } {
  if (!isWellFormedJoinToken(presented)) return { ok: false, reason: 'malformed' };
  if (!record || !hashesEqual(record.tokenHash, hashJoinToken(presented))) {
    return { ok: false, reason: 'unknown' };
  }
  if (record.usedAt !== null) return { ok: false, reason: 'used' };
  if (record.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, record };
}

export class JoinTokenRejectedError extends InvalidInputError {
  constructor(readonly reason: JoinTokenRejection) {
    // One message for every reason: a caller must not learn whether a token exists.
    super('join_token_rejected', 'join token is invalid, expired or already used', { reason });
  }
}
