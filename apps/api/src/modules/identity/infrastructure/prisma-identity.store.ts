import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { isDomainError, Secret } from '@shipkeep/domain';

import type { User } from '../../../platform/prisma/generated/client';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { IdentityStore } from '../application/identity-store';
import { AuthenticationError, SESSION_IDLE_MS } from '../domain/identity-policy';
import type { IdentityTokenRecord, SessionRecord, UserRecord } from '../domain/identity-records';

@Injectable()
export class PrismaIdentityStore implements IdentityStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await this.database.run(operation);
    } catch (error: unknown) {
      if (isDomainError(error)) throw error;
      // Driver diagnostics can contain bound data; never forward them to HTTP error logging.
      throw new ServiceUnavailableException('Identity storage temporarily unavailable.');
    }
  }

  async withUserLock<T>(id: string, operation: (user: UserRecord) => Promise<T>): Promise<T> {
    return this.transaction(async () => {
      await this.database.client.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
      const user = await this.findUser(id);
      if (!user) throw new AuthenticationError();
      return operation(user);
    });
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    return userRecord(await this.database.client.user.findUnique({ where: { email } }));
  }

  async findUser(id: string): Promise<UserRecord | null> {
    return userRecord(await this.database.client.user.findUnique({ where: { id } }));
  }

  async insertUser(user: UserRecord): Promise<boolean> {
    // ON CONFLICT avoids aborting a surrounding transaction during duplicate signups.
    const result = await this.database.client.user.createMany({
      data: [{ ...user, passwordHash: user.passwordHash.expose() }],
      skipDuplicates: true,
    });
    return result.count === 1;
  }

  async activateUser(id: string, now: Date): Promise<void> {
    await this.database.client.user.update({
      where: { id },
      data: { status: 'active', emailVerifiedAt: now, updatedAt: now },
    });
  }

  async changePassword(id: string, hash: Secret, now: Date): Promise<void> {
    await this.database.client.user.update({
      where: { id },
      data: {
        passwordHash: hash.expose(),
        updatedAt: now,
      },
    });
    await this.advanceSecurityVersion(id, now);
  }

  async advanceSecurityVersion(id: string, now: Date): Promise<number> {
    const user = await this.database.client.user.update({
      where: { id },
      data: { securityVersion: { increment: 1 }, updatedAt: now },
    });
    await this.revokeSessions(id, now);
    await this.invalidateTokens(id, 'reset', now);
    return user.securityVersion;
  }

  async insertToken(token: IdentityTokenRecord): Promise<void> {
    await this.database.client.identityToken.create({ data: token });
  }

  async findToken(tokenHash: string): Promise<IdentityTokenRecord | null> {
    const record = await this.database.client.identityToken.findUnique({ where: { tokenHash } });
    if (!record) return null;
    if (record.purpose !== 'verify' && record.purpose !== 'reset') throw new AuthenticationError();
    return { ...record, purpose: record.purpose };
  }

  async consumeToken(id: string, now: Date): Promise<boolean> {
    const result = await this.database.client.identityToken.updateMany({
      where: { id, usedAt: null, expiresAt: { gt: now }, createdAt: { lte: now } },
      data: { usedAt: now, updatedAt: now },
    });
    return result.count === 1;
  }

  async invalidateTokens(
    userId: string,
    purpose: IdentityTokenRecord['purpose'],
    now: Date,
  ): Promise<void> {
    await this.database.client.identityToken.updateMany({
      where: { userId, purpose, usedAt: null },
      data: { usedAt: now, updatedAt: now },
    });
  }

  async insertSession(session: SessionRecord): Promise<void> {
    await this.database.client.userSession.create({ data: session });
  }

  async findSession(
    tokenHash: string,
  ): Promise<{ session: SessionRecord; user: UserRecord } | null> {
    const row = await this.database.client.userSession.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!row) return null;
    const user = userRecord(row.user);
    if (!user) return null;
    const { user: _user, ...session } = row;
    return { session, user };
  }

  async touchSession(id: string, now: Date): Promise<boolean> {
    // Overlapping requests can arrive out of timestamp order. Never move activity backwards
    // or reject a live session merely because another request touched it a millisecond later.
    const oldest = new Date(now.getTime() - SESSION_IDLE_MS);
    const count = await this.database.client.$executeRaw`
      UPDATE user_sessions AS s
      SET last_seen_at = GREATEST(s.last_seen_at, ${now}), updated_at = GREATEST(s.updated_at, ${now})
      WHERE s.id = ${id}::uuid AND s.revoked_at IS NULL AND s.expires_at > ${now}
        AND s.created_at <= ${now} AND s.last_seen_at > ${oldest}
        AND EXISTS (SELECT 1 FROM users AS u WHERE u.id = s.user_id
          AND u.status = 'active' AND u.security_version = s.security_version)`;
    return count === 1;
  }

  async revokeSession(userId: string, tokenHash: string, now: Date): Promise<boolean> {
    const result = await this.database.client.userSession.updateMany({
      where: { userId, tokenHash, revokedAt: null },
      data: { revokedAt: now, updatedAt: now },
    });
    return result.count === 1;
  }

  async revokeSessions(userId: string, now: Date): Promise<void> {
    await this.database.client.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, updatedAt: now },
    });
  }
}

function userRecord(row: User | null): UserRecord | null {
  if (!row) return null;
  if (row.status !== 'pending' && row.status !== 'active' && row.status !== 'disabled')
    throw new AuthenticationError();
  return { ...row, status: row.status, passwordHash: new Secret(row.passwordHash) };
}
