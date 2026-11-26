import { Injectable } from '@nestjs/common';

import type { ThrottleDecision } from '../modules/identity/application/identity-throttle';
import type { IdentityAttempt } from '../modules/identity/domain/throttle-policy';
import { PrismaIdentityThrottle } from '../modules/identity/infrastructure/prisma-identity-throttle';

/**
 * The browser suite drives an account faster than a person can: each step reloads the whole
 * application, and one account then reads about 400 times a minute, from the one address every
 * simulated user shares. Held to the API quota (300 a minute per account, 600 per network), a test
 * failed whenever the read a screen needed was the one refused. The quota keeps its own tests
 * (`identity-throttle.integration.spec.ts`); every limit on credentials still applies here.
 */
@Injectable()
export class BrowserSuiteThrottle extends PrismaIdentityThrottle {
  override async acquire(
    attempt: IdentityAttempt,
    ip: string,
    subject?: string,
    now = new Date(),
  ): Promise<ThrottleDecision> {
    if (attempt !== 'api') return super.acquire(attempt, ip, subject, now);
    return {
      allowed: true,
      limit: 1_000_000,
      remaining: 1_000_000,
      resetAt: now,
      retryAfterSeconds: 0,
    };
  }
}
