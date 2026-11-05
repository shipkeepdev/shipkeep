import { Secret } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

import { ApiTokenAuthentication } from './application/api-token-authentication';
import { API_TOKEN_AUTHORITY, type ApiTokenAuthority } from './application/api-token-authority';
import type { ApiTokenRecord } from './application/api-token-store';
import { hashToken, issueToken } from './infrastructure/identity-secrets';
import { PrismaApiTokenStore } from './infrastructure/prisma-api-token.store';
import { PrismaIdentityStore } from './infrastructure/prisma-identity.store';
import { PrismaIdentityThrottle } from './infrastructure/prisma-identity-throttle';

describe('API token authentication and quotas', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  let users: PrismaIdentityStore;
  let store: PrismaApiTokenStore;
  let auth: ApiTokenAuthentication;
  let record: ApiTokenRecord;
  let token: Secret;
  let now: Date;
  let allowed = true;
  const authority: ApiTokenAuthority = { allows: () => allowed };
  const target = { organizationId: uuidv7(), projectId: uuidv7(), environmentId: uuidv7() };
  beforeAll(async () => {
    fixture = await integrationApp([{ token: API_TOKEN_AUTHORITY, value: authority }]);
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
    const database = fixture.app.get(PrismaUnitOfWork);
    users = new PrismaIdentityStore(database);
    store = new PrismaApiTokenStore(database);
    auth = fixture.app.get(ApiTokenAuthentication);
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    now = new Date();
    token = issueToken();
    allowed = true;
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
      name: 'Deployment',
      tokenHash: hashToken('api', token),
      scopes: [{ permission: 'deploy.run', ...target }],
      securityVersion: 0,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3600000),
      revokedAt: null,
      lastUsedAt: null,
    };
    await store.insert(record);
  });

  it('intersects scope with current owner authority on every request', async () => {
    expect((await auth.authenticate(token, 'deploy.run', target, now)).user.id).toBe(record.userId);
    expect((await store.findOwned(record.userId, record.id))?.lastUsedAt).toEqual(now);
    for (const resource of [
      {},
      { ...target, organizationId: uuidv7() },
      { ...target, projectId: uuidv7() },
      { ...target, environmentId: uuidv7() },
    ])
      await expect(auth.authenticate(token, 'deploy.run', resource, now)).rejects.toThrow(
        'Permission denied.',
      );
    await expect(auth.authenticate(token, 'secret.write', target, now)).rejects.toThrow(
      'Permission denied.',
    );
    allowed = false;
    await expect(auth.authenticate(token, 'deploy.run', target, now)).rejects.toThrow(
      'Permission denied.',
    );
    await expect(auth.assertReplayAvailable(record.userId, 0, token, now)).rejects.toThrow(
      'Permission denied.',
    );
    allowed = true;
    await expect(auth.assertReplayAvailable(record.userId, 0, token, now)).resolves.toBeUndefined();
    await expect(auth.assertReplayAvailable(uuidv7(), 0, token, now)).rejects.toThrow(
      'Authentication failed.',
    );
    await expect(auth.assertReplayAvailable(record.userId, 1, token, now)).rejects.toThrow(
      'Authentication failed.',
    );
  });

  it('rejects malformed, unknown and purpose-mismatched credentials', async () => {
    for (const value of [new Secret('invalid'), issueToken(), new Secret(`${token.expose()} `)])
      await expect(auth.authenticate(value, 'deploy.run', target, now)).rejects.toThrow(
        'Authentication failed.',
      );
    await prisma.apiToken.update({
      where: { id: record.id },
      data: { tokenHash: hashToken('session', token) },
    });
    await expect(auth.authenticate(token, 'deploy.run', target, now)).rejects.toThrow(
      'Authentication failed.',
    );
  });

  it('rejects expiry, future creation, account disablement, password changes and revocation', async () => {
    for (const time of [new Date(now.getTime() - 1), record.expiresAt])
      await expect(auth.authenticate(token, 'deploy.run', target, time)).rejects.toThrow(
        'Authentication failed.',
      );
    await prisma.user.update({ where: { id: record.userId }, data: { status: 'disabled' } });
    await expect(auth.authenticate(token, 'deploy.run', target, now)).rejects.toThrow(
      'Authentication failed.',
    );
    await prisma.user.update({ where: { id: record.userId }, data: { status: 'active' } });
    await users.withUserLock(record.userId, () => users.advanceSecurityVersion(record.userId, now));
    await expect(auth.authenticate(token, 'deploy.run', target, now)).rejects.toThrow(
      'Authentication failed.',
    );
    await prisma.apiToken.update({ where: { id: record.id }, data: { securityVersion: 1 } });
    await store.revoke(record.userId, record.id, now);
    await expect(auth.authenticate(token, 'deploy.run', target, now)).rejects.toThrow(
      'Authentication failed.',
    );
  });

  it('shares quotas across instances and IPs, with exact window expiry and hashed subjects', async () => {
    const first = new PrismaIdentityThrottle(fixture.app.get(PrismaUnitOfWork));
    const second = new PrismaIdentityThrottle(new PrismaUnitOfWork(prisma));
    await prisma.identityThrottle.deleteMany();
    for (let index = 0; index < 300; index++)
      expect(
        (
          await (index % 2 ? first : second).acquire(
            'api',
            `192.0.2.${String((index % 2) + 1)}`,
            token.expose(),
            now,
          )
        ).allowed,
      ).toBe(true);
    expect(await first.acquire('api', '192.0.2.3', token.expose(), now)).toMatchObject({
      allowed: false,
      limit: 300,
      remaining: 0,
      retryAfterSeconds: 60,
    });
    expect(
      (await first.acquire('api', '192.0.2.3', token.expose(), new Date(now.getTime() + 60000)))
        .remaining,
    ).toBe(299);
    const later = new Date(now.getTime() + 60000);
    for (let index = 0; index < 600; index++)
      expect((await first.acquire('api', '192.0.2.4', undefined, later)).allowed).toBe(true);
    expect(await second.acquire('api', '192.0.2.4', issueToken().expose(), later)).toMatchObject({
      allowed: false,
      limit: 600,
    });
    expect(JSON.stringify(await prisma.identityThrottle.findMany())).not.toContain(token.expose());
  });

  it('admits out-of-order API requests without bypassing progressive identity delays', async () => {
    const throttle = new PrismaIdentityThrottle(fixture.app.get(PrismaUnitOfWork));
    const later = new Date(now.getTime() + 10);
    // Concurrent requests capture their timestamps before acquiring the shared IP row lock.
    // The later request can commit first even though this API quota has no progressive delay.
    expect((await throttle.acquire('api', '192.0.2.8', token.expose(), later)).allowed).toBe(true);
    expect(await throttle.acquire('api', '192.0.2.8', token.expose(), now)).toMatchObject({
      allowed: true,
      remaining: 298,
    });
    await throttle.acquire('login', '192.0.2.8', record.userId, later);
    expect(await throttle.acquire('login', '192.0.2.8', record.userId, now)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });
});
