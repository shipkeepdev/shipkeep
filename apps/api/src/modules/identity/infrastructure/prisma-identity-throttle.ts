import { createHash } from 'node:crypto';

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { IdentityThrottle, ThrottleDecision } from '../application/identity-throttle';
import { type IdentityAttempt, type ThrottleAxis, throttlePolicy } from '../domain/throttle-policy';

@Injectable()
export class PrismaIdentityThrottle implements IdentityThrottle {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async acquire(
    attempt: IdentityAttempt,
    ip: string,
    subject?: string,
    now = new Date(),
  ): Promise<ThrottleDecision> {
    try {
      return await this.database.run(async () => {
        // Bounded cleanup keeps expired attacker-selected keys from accumulating indefinitely.
        await this.database.client.$executeRaw`DELETE FROM identity_throttles WHERE id IN (
          SELECT id FROM identity_throttles WHERE window_ends_at <= ${now}
          ORDER BY window_ends_at, id LIMIT 100 FOR UPDATE SKIP LOCKED)`;
        const ipDecision = await this.claim(attempt, 'ip', ip, now);
        if (!ipDecision.allowed || subject === undefined) return ipDecision;
        return this.claim(attempt, 'subject', subject, now);
      });
    } catch {
      throw new ServiceUnavailableException('Authentication temporarily unavailable.');
    }
  }

  async succeeded(subject: string): Promise<void> {
    try {
      await this.database.client.identityThrottle.deleteMany({
        where: { keyHash: key('login', 'subject', subject) },
      });
    } catch {
      throw new ServiceUnavailableException('Authentication temporarily unavailable.');
    }
  }

  private async claim(
    attempt: IdentityAttempt,
    axis: ThrottleAxis,
    principal: string,
    now: Date,
  ): Promise<ThrottleDecision> {
    const policy = throttlePolicy(attempt, axis);
    const keyHash = key(attempt, axis, principal);
    const endsAt = new Date(now.getTime() + policy.windowMs);
    const initialDelay = policy.progressive ? 250 : 0;
    const next = new Date(now.getTime() + initialDelay);
    const rows = await this.database.client.$queryRaw<
      { hits: number; windowEndsAt: Date; nextAllowedAt: Date }[]
    >`
      INSERT INTO identity_throttles (id,key_hash,hits,window_ends_at,next_allowed_at,created_at,updated_at)
      VALUES (${uuidv7()}::uuid,${keyHash},1,${endsAt},${next},${now},${now})
      ON CONFLICT (key_hash) DO UPDATE SET
        hits = CASE WHEN identity_throttles.window_ends_at <= ${now} THEN 1 ELSE identity_throttles.hits + 1 END,
        window_ends_at = CASE WHEN identity_throttles.window_ends_at <= ${now} THEN ${endsAt} ELSE identity_throttles.window_ends_at END,
        next_allowed_at = ${now}::timestamptz + (CASE WHEN identity_throttles.window_ends_at <= ${now}
          THEN ${initialDelay} ELSE ${initialDelay} * power(2, LEAST(identity_throttles.hits, 8)) END) * interval '1 millisecond',
        updated_at = ${now}
      WHERE identity_throttles.next_allowed_at <= ${now}
        AND (identity_throttles.window_ends_at <= ${now} OR identity_throttles.hits < ${policy.limit})
      RETURNING hits, window_ends_at AS "windowEndsAt", next_allowed_at AS "nextAllowedAt"`;
    const admitted = rows.at(0);
    if (admitted)
      return {
        allowed: true,
        limit: policy.limit,
        remaining: policy.limit - admitted.hits,
        resetAt: admitted.windowEndsAt,
        retryAfterSeconds: 0,
      };
    const blocked = await this.database.client.identityThrottle.findUniqueOrThrow({
      where: { keyHash },
    });
    const retryAt = blocked.hits >= policy.limit ? blocked.windowEndsAt : blocked.nextAllowedAt;
    return {
      allowed: false,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - blocked.hits),
      resetAt: blocked.windowEndsAt,
      retryAfterSeconds: Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000)),
    };
  }
}

function key(attempt: IdentityAttempt, axis: ThrottleAxis, principal: string): string {
  return createHash('sha256')
    .update(`shipkeep:identity-throttle:${attempt}:${axis}:`)
    .update(principal)
    .digest('hex');
}
