import { Injectable } from '@nestjs/common';
import { InvalidInputError } from '@shipkeep/domain';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { MfaRecord, MfaStore } from '../application/mfa-store';

@Injectable()
export class PrismaMfaStore implements MfaStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async find(userId: string): Promise<MfaRecord | null> {
    const row = await this.database.client.userMfa.findUnique({ where: { userId } });
    return row
      ? { ...row, lastCounter: row.lastCounter === null ? null : Number(row.lastCounter) }
      : null;
  }

  async stage(
    userId: string,
    ciphertext: Uint8Array,
    securityVersion: number,
    now: Date,
  ): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + 600000);
    return (
      (await this.database.client.$executeRaw`
      INSERT INTO user_mfa (user_id,pending_ciphertext,pending_version,pending_created_at,pending_expires_at,updated_at)
      VALUES (${userId}::uuid,${Buffer.from(ciphertext)},${securityVersion},${now},${expiresAt},${now})
      ON CONFLICT (user_id) DO UPDATE SET pending_ciphertext = EXCLUDED.pending_ciphertext,
        pending_version = EXCLUDED.pending_version, pending_created_at = EXCLUDED.pending_created_at,
        pending_expires_at = EXCLUDED.pending_expires_at, updated_at = EXCLUDED.updated_at
      WHERE user_mfa.active_ciphertext IS NULL`) === 1
    );
  }

  async activate(userId: string, counter: number, now: Date): Promise<boolean> {
    assertCounter(counter);
    return (
      (await this.database.client.$executeRaw`
      UPDATE user_mfa AS m SET active_ciphertext = pending_ciphertext, enabled_at = ${now},
        last_counter = ${BigInt(counter)}, pending_ciphertext = NULL, pending_version = NULL,
        pending_created_at = NULL, pending_expires_at = NULL, updated_at = ${now}
      WHERE m.user_id = ${userId}::uuid AND m.active_ciphertext IS NULL
        AND m.pending_created_at <= ${now} AND m.pending_expires_at > ${now}
        AND EXISTS (SELECT 1 FROM users AS u WHERE u.id = m.user_id
          AND u.status = 'active' AND u.security_version = m.pending_version)`) === 1
    );
  }

  async claimCounter(userId: string, counter: number, now: Date): Promise<boolean> {
    assertCounter(counter);
    const result = await this.database.client.userMfa.updateMany({
      where: { userId, activeCiphertext: { not: null }, lastCounter: { lt: BigInt(counter) } },
      data: { lastCounter: BigInt(counter), updatedAt: now },
    });
    return result.count === 1;
  }

  async replaceRecovery(userId: string, hashes: readonly string[], now: Date): Promise<void> {
    if (
      hashes.length !== 10 ||
      new Set(hashes).size !== 10 ||
      hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
    )
      throw new InvalidInputError(
        'invalid_recovery_codes',
        'Ten unique recovery-code hashes are required.',
      );
    await this.database.client.recoveryCode.deleteMany({ where: { userId } });
    await this.database.client.recoveryCode.createMany({
      data: hashes.map((codeHash) => ({ userId, codeHash, createdAt: now })),
    });
  }

  async claimRecovery(userId: string, hash: string, now: Date): Promise<boolean> {
    return (
      (await this.database.client.$executeRaw`
      UPDATE recovery_codes AS r SET used_at = ${now}
      WHERE user_id = ${userId}::uuid AND code_hash = ${hash} AND used_at IS NULL AND created_at <= ${now}
        AND EXISTS (SELECT 1 FROM user_mfa AS m WHERE m.user_id = r.user_id AND m.active_ciphertext IS NOT NULL)`) ===
      1
    );
  }

  async remove(userId: string): Promise<void> {
    await this.database.client.userMfa.deleteMany({ where: { userId } });
  }

  async remainingRecovery(userId: string): Promise<number> {
    return this.database.client.recoveryCode.count({ where: { userId, usedAt: null } });
  }
}

function assertCounter(counter: number): void {
  if (!Number.isSafeInteger(counter) || counter < 0)
    throw new InvalidInputError('invalid_totp_counter', 'Invalid authentication counter.');
}
