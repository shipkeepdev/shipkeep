import { Injectable } from '@nestjs/common';
import { parseApiScopes } from '@shipkeep/domain';

import type { ApiToken } from '../../../platform/prisma/generated/client';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { ApiTokenRecord, ApiTokenStore } from '../application/api-token-store';

@Injectable()
export class PrismaApiTokenStore implements ApiTokenStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async insert(record: ApiTokenRecord): Promise<void> {
    await this.database.client.apiToken.create({
      data: { ...record, scopes: parseApiScopes(record.scopes).map((scope) => ({ ...scope })) },
    });
  }
  async findByHash(tokenHash: string): Promise<ApiTokenRecord | null> {
    return fromRow(await this.database.client.apiToken.findUnique({ where: { tokenHash } }));
  }
  async findOwned(userId: string, id: string): Promise<ApiTokenRecord | null> {
    return fromRow(await this.database.client.apiToken.findFirst({ where: { userId, id } }));
  }
  async list(userId: string, beforeId?: string): Promise<ApiTokenRecord[]> {
    const rows = await this.database.client.apiToken.findMany({
      where: { userId, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 100,
    });
    return rows.map((row) => ({ ...row, scopes: parseApiScopes(row.scopes) }));
  }
  async countActive(userId: string, securityVersion: number, now: Date): Promise<number> {
    return this.database.client.apiToken.count({
      where: {
        userId,
        securityVersion,
        revokedAt: null,
        createdAt: { lte: now },
        expiresAt: { gt: now },
      },
    });
  }
  async revoke(userId: string, id: string, now: Date): Promise<boolean> {
    const result = await this.database.client.apiToken.updateMany({
      where: { userId, id, revokedAt: null, createdAt: { lte: now } },
      data: { revokedAt: now },
    });
    return result.count === 1;
  }
  async touch(id: string, now: Date): Promise<boolean> {
    return (
      (await this.database.client.$executeRaw`
      UPDATE api_tokens AS t SET last_used_at = GREATEST(t.last_used_at, ${now})
      WHERE t.id = ${id}::uuid AND t.revoked_at IS NULL AND t.created_at <= ${now} AND t.expires_at > ${now}
        AND EXISTS (SELECT 1 FROM users AS u WHERE u.id = t.user_id
          AND u.status = 'active' AND u.security_version = t.security_version)`) === 1
    );
  }
}
function fromRow(row: ApiToken | null): ApiTokenRecord | null {
  return row ? { ...row, scopes: parseApiScopes(row.scopes) } : null;
}
