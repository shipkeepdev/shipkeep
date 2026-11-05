import { Secret } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

import type { ApiTokenRecord } from './application/api-token-store';
import { hashToken, issueToken } from './infrastructure/identity-secrets';
import { PrismaApiTokenStore } from './infrastructure/prisma-api-token.store';
import { PrismaIdentityStore } from './infrastructure/prisma-identity.store';

describe('API token persistence against PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  let users: PrismaIdentityStore;
  let store: PrismaApiTokenStore;
  let peer: PrismaApiTokenStore;
  let record: ApiTokenRecord;
  let value: Secret;
  let now: Date;
  beforeAll(async () => {
    fixture = await integrationApp();
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
    const database = fixture.app.get(PrismaUnitOfWork);
    users = new PrismaIdentityStore(database);
    store = new PrismaApiTokenStore(database);
    peer = new PrismaApiTokenStore(new PrismaUnitOfWork(prisma));
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    now = new Date();
    value = issueToken();
    const userId = uuidv7();
    await users.insertUser({
      id: userId,
      email: `${userId}@example.com`,
      passwordHash: new Secret('test-hash'),
      status: 'active',
      emailVerifiedAt: now,
      securityVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    record = {
      id: uuidv7(),
      userId,
      name: 'Read profile',
      tokenHash: hashToken('api', value),
      scopes: [{ permission: 'profile.read' }],
      securityVersion: 0,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3600000),
      revokedAt: null,
      lastUsedAt: null,
    };
  });

  it('stores only a purpose-bound hash and lists only the requested owner', async () => {
    await store.insert(record);
    expect(await store.findByHash(record.tokenHash)).toEqual(record);
    expect(await store.findOwned(uuidv7(), record.id)).toBeNull();
    expect(await store.list(uuidv7())).toEqual([]);
    expect(await store.list(record.userId)).toEqual([record]);
    expect(await store.list(record.userId, record.id)).toEqual([]);
    expect(JSON.stringify(await prisma.apiToken.findMany())).not.toContain(value.expose());
    expect(await store.countActive(record.userId, 0, now)).toBe(1);
    expect(await store.countActive(record.userId, 1, now)).toBe(0);
    expect(await store.countActive(record.userId, 0, record.expiresAt)).toBe(0);
  });

  it('touches live tokens monotonically and refuses expired, revoked or stale credentials', async () => {
    await store.insert(record);
    const later = new Date(now.getTime() + 1000);
    expect(await store.touch(record.id, later)).toBe(true);
    expect(await peer.touch(record.id, now)).toBe(true);
    expect((await store.findOwned(record.userId, record.id))?.lastUsedAt).toEqual(later);
    expect(await store.touch(record.id, new Date(now.getTime() - 1))).toBe(false);
    expect(await store.touch(record.id, record.expiresAt)).toBe(false);
    await users.withUserLock(record.userId, () => users.advanceSecurityVersion(record.userId, now));
    expect(await store.touch(record.id, now)).toBe(false);
    await prisma.apiToken.update({ where: { id: record.id }, data: { securityVersion: 1 } });
    await prisma.user.update({ where: { id: record.userId }, data: { status: 'disabled' } });
    expect(await store.touch(record.id, now)).toBe(false);
    await prisma.user.update({ where: { id: record.userId }, data: { status: 'active' } });
    expect(await store.touch(record.id, now)).toBe(true);
    expect(await store.revoke(uuidv7(), record.id, now)).toBe(false);
    const revoked = await Promise.all(
      [store, peer].map((item) => item.revoke(record.userId, record.id, now)),
    );
    expect(revoked.filter(Boolean)).toHaveLength(1);
    expect(await store.touch(record.id, now)).toBe(false);
    expect(await store.countActive(record.userId, 1, now)).toBe(0);
  });

  it('rolls back a command transaction and enforces database constraints', async () => {
    await expect(
      users.withUserLock(record.userId, async () => {
        await store.insert(record);
        throw new Error('injected failure');
      }),
    ).rejects.toThrow('Identity storage temporarily unavailable.');
    expect(await store.findByHash(record.tokenHash)).toBeNull();
    for (const invalid of [
      { ...record, tokenHash: value.expose() },
      { ...record, expiresAt: now },
      { ...record, expiresAt: new Date(now.getTime() + 91 * 86400000) },
      { ...record, securityVersion: -1 },
      { ...record, name: ' ' },
    ])
      await expect(store.insert(invalid)).rejects.toThrow();
    await store.insert(record);
    await expect(store.insert({ ...record, id: uuidv7() })).rejects.toThrow();
    await expect(
      prisma.$executeRaw`UPDATE api_tokens SET scopes = '[]'::jsonb WHERE id = ${record.id}::uuid`,
    ).rejects.toThrow();
  });
});
