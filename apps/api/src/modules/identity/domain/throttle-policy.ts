export type IdentityAttempt =
  'login' | 'register' | 'email' | 'verify' | 'reset' | 'mfa' | 'token' | 'api';
export type ThrottleAxis = 'ip' | 'subject';
export interface ThrottlePolicy {
  readonly limit: number;
  readonly windowMs: number;
  readonly progressive: boolean;
}

export function throttlePolicy(attempt: IdentityAttempt, axis: ThrottleAxis): ThrottlePolicy {
  if (attempt === 'api')
    return { limit: axis === 'ip' ? 600 : 300, windowMs: 60000, progressive: false };
  const delivery = attempt === 'email' || attempt === 'register';
  return {
    limit: axis === 'ip' ? (delivery ? 20 : 100) : delivery ? 5 : 10,
    windowMs: delivery ? 3600000 : 900000,
    progressive: axis === 'subject' && !delivery,
  };
}
