import { InvalidInputError, isTenantId, type Permission } from '@shipkeep/domain';

/** Lifetime of a confirmation token (SPEC 3.6). */
export const CONFIRMATION_TTL_SECONDS = 300;
/** Tolerated clock difference when checking `iat`. */
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 2048;

/**
 * Closed catalog of destructive actions that need a confirmation token, with the permission the
 * requester must hold on the action's scope. New destructive actions are added here with their
 * resolver and endpoint, never accepted by name alone.
 */
export const CONFIRMABLE_ACTIONS = {
  'node.remove': { permission: 'node.manage', scope: 'organization' },
} as const satisfies Record<string, { permission: Permission; scope: 'organization' }>;
export type ConfirmableAction = keyof typeof CONFIRMABLE_ACTIONS;

export function isConfirmableAction(value: unknown): value is ConfirmableAction {
  return typeof value === 'string' && Object.hasOwn(CONFIRMABLE_ACTIONS, value);
}

/** JWT claims of a confirmation token; times are whole seconds since the epoch. */
export interface ConfirmationClaims {
  readonly jti: string;
  readonly org: string;
  readonly action: ConfirmableAction;
  readonly target: string;
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
}

export interface ConfirmationRequest {
  readonly organizationId: string;
  readonly action: ConfirmableAction;
  readonly target: string;
}

export class ConfirmationRejectedError extends InvalidInputError {
  constructor() {
    // One message for every reason: a caller learns nothing about which check failed.
    super('confirmation_rejected', 'The confirmation is invalid, expired, used or does not match.');
  }
}

const HEADER = base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
const TARGET = /^[A-Za-z0-9._:/-]{1,128}$/;

export function confirmationClaims(input: {
  id: string;
  request: ConfirmationRequest;
  userId: string;
  now: Date;
}): ConfirmationClaims {
  const iat = Math.floor(input.now.getTime() / 1000);
  const claims = {
    jti: input.id,
    org: input.request.organizationId,
    action: input.request.action,
    target: input.request.target,
    sub: input.userId,
    iat,
    exp: iat + CONFIRMATION_TTL_SECONDS,
  };
  if (!validClaims(claims)) throw new ConfirmationRejectedError();
  return claims;
}

/** `base64url(header).base64url(claims)`, the bytes the confirmation key signs. */
export function signingInput(claims: ConfirmationClaims): string {
  // Fixed key order: the token is reproducible and never carries unexpected members.
  const payload = {
    jti: claims.jti,
    org: claims.org,
    action: claims.action,
    target: claims.target,
    sub: claims.sub,
    iat: claims.iat,
    exp: claims.exp,
  };
  return `${HEADER}.${base64url(JSON.stringify(payload))}`;
}

export function compactToken(input: string, signature: Uint8Array): string {
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

/** Strict parse: exact header, exact claim set, canonical encodings. Null when malformed. */
export function parseConfirmationToken(
  token: string,
): { claims: ConfirmationClaims; signingInput: string; signature: Uint8Array } | null {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return null;
  const [, payload = '', signature = ''] = parts;
  const bytes = decode(signature);
  if (!bytes || bytes.length !== 64) return null;
  const json = decode(payload);
  if (!json) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(json.toString('utf8'));
  } catch {
    return null;
  }
  if (!validClaims(claims)) return null;
  const input = `${HEADER}.${payload}`;
  // Reject equivalent but non-canonical payloads (key order, whitespace, extra members).
  if (signingInput(claims) !== input) return null;
  return { claims, signingInput: input, signature: bytes };
}

/** Claims match the request, the requester and the clock (expiry is exclusive). */
export function claimsMatch(
  claims: ConfirmationClaims,
  request: ConfirmationRequest,
  userId: string,
  now: Date,
): boolean {
  const seconds = Math.floor(now.getTime() / 1000);
  // Widened on purpose: the catalog grows, and a narrowed literal type must not skip the check.
  const action: string = claims.action;
  return (
    claims.org === request.organizationId &&
    action === request.action &&
    claims.target === request.target &&
    claims.sub === userId &&
    claims.iat <= seconds + CLOCK_SKEW_SECONDS &&
    seconds < claims.exp
  );
}

/** The typed confirmation must equal the resource's current name exactly. */
export function confirmationNameMatches(typed: string, actual: string): boolean {
  return typed.length > 0 && typed === actual;
}

function validClaims(value: unknown): value is ConfirmationClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  const keys = Object.keys(claims).sort().join(',');
  return (
    keys === 'action,exp,iat,jti,org,sub,target' &&
    isTenantId(claims['jti']) &&
    isTenantId(claims['org']) &&
    isTenantId(claims['sub']) &&
    isConfirmableAction(claims['action']) &&
    typeof claims['target'] === 'string' &&
    TARGET.test(claims['target']) &&
    Number.isSafeInteger(claims['iat']) &&
    Number.isSafeInteger(claims['exp']) &&
    (claims['exp'] as number) - (claims['iat'] as number) === CONFIRMATION_TTL_SECONDS
  );
}
function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
function decode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  // Only the canonical encoding round-trips; this rejects padding bits and aliases.
  return bytes.toString('base64url') === value ? bytes : null;
}
