import type { IdentityAttempt } from '../domain/throttle-policy';

export const IDENTITY_THROTTLE = Symbol('IdentityThrottle');
export interface ThrottleDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: Date;
  readonly retryAfterSeconds: number;
}
export interface IdentityThrottle {
  acquire(
    attempt: IdentityAttempt,
    ip: string,
    subject?: string,
    now?: Date,
  ): Promise<ThrottleDecision>;
  succeeded(subject: string): Promise<void>;
}
