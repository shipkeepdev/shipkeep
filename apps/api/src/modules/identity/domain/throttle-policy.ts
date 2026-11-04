export type IdentityAttempt = 'login' | 'register' | 'email' | 'verify' | 'reset' | 'mfa' | 'token';
export type ThrottleAxis = 'ip' | 'subject';
export interface ThrottlePolicy {
  readonly limit: number;
  readonly windowMs: number;
  readonly progressive: boolean;
}

export function throttlePolicy(attempt: IdentityAttempt, axis: ThrottleAxis): ThrottlePolicy {
  const delivery = attempt === 'email' || attempt === 'register';
  return {
    limit: axis === 'ip' ? (delivery ? 20 : 100) : delivery ? 5 : 10,
    windowMs: delivery ? 3600000 : 900000,
    progressive: axis === 'subject' && !delivery,
  };
}
