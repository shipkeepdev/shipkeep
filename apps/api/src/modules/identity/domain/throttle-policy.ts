export type IdentityAttempt =
  'login' | 'register' | 'email' | 'verify' | 'reset' | 'mfa' | 'token' | 'api';
/**
 * - `ip`: one client network (IPv4 address or IPv6 /64) across every account.
 * - `subject`: one account (or token) from every network.
 * - `source`: one account from one client network.
 */
export type ThrottleAxis = 'ip' | 'subject' | 'source';
export interface ThrottlePolicy {
  readonly limit: number;
  readonly windowMs: number;
  readonly progressive: boolean;
  /** Progressive delay doubles per hit from 250 ms, up to 250 ms × 2^maxDelaySteps. */
  readonly maxDelaySteps: number;
}

/** Ceiling that is never reached in practice; the global account axis only delays. */
const UNCAPPED = 1_000_000;

export function throttlePolicy(attempt: IdentityAttempt, axis: ThrottleAxis): ThrottlePolicy {
  if (attempt === 'api')
    return {
      limit: axis === 'ip' ? 600 : 300,
      windowMs: 60000,
      progressive: false,
      maxDelaySteps: 0,
    };
  if (attempt === 'email' || attempt === 'register') {
    // Delivery attempts keep a hard per-account cap: it is what stops mailbox flooding.
    return {
      limit: axis === 'ip' ? 20 : 5,
      windowMs: 3600000,
      progressive: false,
      maxDelaySteps: 0,
    };
  }
  // Credential proofs. A hard per-account cap would let anyone lock the owner out by failing on
  // purpose, so the hard cap applies per account *and* client network; the global account axis
  // only slows distributed guessing with a bounded delay (at most 8 s between attempts).
  switch (axis) {
    case 'ip':
      return { limit: 100, windowMs: 900000, progressive: false, maxDelaySteps: 0 };
    case 'source':
      return { limit: 10, windowMs: 900000, progressive: true, maxDelaySteps: 8 };
    case 'subject':
      return { limit: UNCAPPED, windowMs: 900000, progressive: true, maxDelaySteps: 5 };
  }
}

/** Whether an attempt is also limited per account and client network. */
export function usesSourceAxis(attempt: IdentityAttempt): boolean {
  return attempt !== 'api' && attempt !== 'email' && attempt !== 'register';
}
