import type { Server } from 'node:http';

import { Secret } from '@shipkeep/domain';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { integrationApp } from '../../testing/integration-app';

import { API_TOKEN_STORE, type ApiTokenStore } from './application/api-token-store';
import { IDENTITY_STORE, type IdentityStore } from './application/identity-store';
import { hashToken, issueToken } from './infrastructure/identity-secrets';

describe('Bearer HTTP acceptance', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  let token: Secret;
  let id: string;
  let userId: string;
  let cookie: string;
  const http = () => request(fixture.app.getHttpServer() as Server);
  const profile = () =>
    http().get('/api/v1/auth/session').set('Authorization', `Bearer ${token.expose()}`);
  beforeAll(async () => {
    fixture = await integrationApp();
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    await prisma.identityThrottle.deleteMany();
    token = issueToken();
    id = uuidv7();
    userId = uuidv7();
    const now = new Date();
    const users = fixture.app.get<IdentityStore>(IDENTITY_STORE);
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
    await fixture.app.get<ApiTokenStore>(API_TOKEN_STORE).insert({
      id,
      userId,
      name: 'Read profile',
      tokenHash: hashToken('api', token),
      scopes: [{ permission: 'profile.read' }],
      securityVersion: 0,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3600000),
      revokedAt: null,
      lastUsedAt: null,
    });
    const session = issueToken();
    cookie = `shipkeep_session=${session.expose()}`;
    await users.insertSession({
      id: uuidv7(),
      userId,
      tokenHash: hashToken('session', session),
      csrfHash: hashToken('csrf', issueToken()),
      securityVersion: 0,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 7 * 86400000),
      revokedAt: null,
      ip: '127.0.0.1',
      userAgent: 'Bearer fixture',
    });
  });

  it('returns only permitted profile metadata with API quota headers and no session cookies', async () => {
    const response = await profile().expect(200).expect('Cache-Control', 'no-store');
    expect(response.body).toMatchObject({ userId, email: `${userId}@example.com` });
    expect(response.headers).toMatchObject({
      'ratelimit-limit': '300',
      'ratelimit-remaining': '299',
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(token.expose());
    expect((await prisma.apiToken.findUniqueOrThrow({ where: { id } })).lastUsedAt).not.toBeNull();
    await http().get('/api/v1/auth/session').set('Cookie', cookie).expect(200);
  });

  it('denies undeclared routes and never falls back to a valid browser session', async () => {
    await http()
      .get('/api/v1/auth/mfa')
      .set('Authorization', `Bearer ${token.expose()}`)
      .expect(401);
    await http()
      .post('/api/v1/auth/mfa/setup')
      .set('Authorization', `Bearer ${token.expose()}`)
      .send({ password: 'test fixture password' })
      .expect(401);
    for (const value of [
      'Bearer invalid',
      `Basic ${token.expose()}`,
      `Bearer ${issueToken().expose()}`,
      `Bearer ${token.expose()}, Bearer ${token.expose()}`,
    ])
      await http()
        .get('/api/v1/auth/session')
        .set('Cookie', cookie)
        .set('Authorization', value)
        .expect(401);
    await http()
      .get('/api/v1/auth/session')
      .set({ Authorization: [`Bearer ${token.expose()}`, `Bearer ${token.expose()}`] })
      .expect(401);
  });

  it('rejects mismatched scopes and invalidated credentials immediately', async () => {
    await prisma.apiToken.update({
      where: { id },
      data: { scopes: [{ permission: 'organization.read', organizationId: uuidv7() }] },
    });
    await profile().expect(403);
    await prisma.apiToken.update({
      where: { id },
      data: { scopes: [{ permission: 'profile.read' }], revokedAt: new Date() },
    });
    await profile().expect(401);
    await prisma.apiToken.update({ where: { id }, data: { revokedAt: null } });
    await fixture.app
      .get<IdentityStore>(IDENTITY_STORE)
      .withUserLock(userId, () =>
        fixture.app.get<IdentityStore>(IDENTITY_STORE).advanceSecurityVersion(userId, new Date()),
      );
    await profile().expect(401);
  });

  it('enforces the token budget before authentication and counts malformed attempts against the IP', async () => {
    await profile().expect(200);
    // Policy boundaries are exercised by the real quota suite; place the HTTP fixture at its boundary.
    // Saturate the token budget while leaving 300 requests in the IP budget.
    await prisma.identityThrottle.updateMany({ data: { hits: 300 } });
    const denied = await profile().expect(429);
    expect(denied.headers['retry-after']).toBeDefined();
    await prisma.identityThrottle.deleteMany();
    await http().get('/api/v1/auth/session').set('Authorization', 'Bearer invalid').expect(401);
    expect(await prisma.identityThrottle.count()).toBe(1);
    await prisma.identityThrottle.updateMany({ data: { hits: 600 } });
    await http().get('/api/v1/auth/session').set('Authorization', 'Bearer invalid').expect(429);
  });
});
