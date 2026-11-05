import type { Server } from 'node:http';

import { Secret } from '@shipkeep/domain';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';

import { AppConfig } from '../../platform/config/app-config';
import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { integrationApp } from '../../testing/integration-app';

import { PASSWORD_HASHER, type PasswordHashing } from './application/identity-ports';
import { IDENTITY_STORE, type IdentityStore } from './application/identity-store';
import { SessionCommands } from './application/session-commands';
import { cookiePolicy } from './interface/session-http';

describe('API token management HTTP acceptance', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  let current: { id: string; cookie: string; csrf: string };
  let passwordHash: Secret;
  let origin: string;
  const password = 'correct horse token HTTP password';
  const http = () => request(fixture.app.getHttpServer() as Server);
  const post = (path: string, body: object, browser = current) =>
    http()
      .post(`/api/v1/api-tokens${path}`)
      .set('Origin', origin)
      .set('Cookie', browser.cookie)
      .set('X-Shipkeep-CSRF', browser.csrf)
      .send(body);
  const list = (query = '') =>
    http().get(`/api/v1/api-tokens${query}`).set('Cookie', current.cookie);
  const resetLimits = () => prisma.identityThrottle.deleteMany();
  const payload = () => ({
    password,
    name: 'Automation',
    scopes: [{ permission: 'profile.read' }],
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
  beforeAll(async () => {
    fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
    origin = new URL(fixture.app.get(AppConfig).get('API_PUBLIC_URL')).origin;
    passwordHash = await fixture.app
      .get<PasswordHashing>(PASSWORD_HASHER)
      .hash(new Secret(password));
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    await resetLimits();
    current = await browser();
  });
  async function browser() {
    const id = uuidv7();
    const now = new Date();
    const email = `${id}@example.com`;
    await fixture.app.get<IdentityStore>(IDENTITY_STORE).insertUser({
      id,
      email,
      passwordHash,
      status: 'active',
      emailVerifiedAt: now,
      securityVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const session = await fixture.app
      .get(SessionCommands)
      .login({ email, password: new Secret(password), ip: '127.0.0.1', userAgent: 'fixture' });
    const policy = cookiePolicy(origin);
    return { id, cookie: `${policy.name}=${session.token.expose()}`, csrf: session.csrf.expose() };
  }

  it('creates once, lists only metadata, paginates and revokes with an encrypted retry', async () => {
    const body = payload();
    const key = uuidv7();
    const first = await post('', body)
      .set('Idempotency-Key', key)
      .expect(201)
      .expect('Cache-Control', 'no-store');
    const created = first.body as { id: string; token: string };
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await resetLimits();
    const replay = await post('', body)
      .set('Idempotency-Key', key)
      .expect(201)
      .expect('Idempotency-Replayed', 'true');
    expect(replay.body).toEqual(first.body);
    expect(await prisma.apiToken.count({ where: { userId: current.id } })).toBe(1);
    await resetLimits();
    const second = await post('', payload()).expect(201);
    const page = await list('?limit=1').expect(200);
    expect(page.body).toMatchObject({
      items: [{ id: (second.body as { id: string }).id }],
      nextCursor: (second.body as { id: string }).id,
    });
    const next = await list(
      `?limit=1&cursor=${(page.body as { nextCursor: string }).nextCursor}`,
    ).expect(200);
    expect((next.body as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
      created.id,
    ]);
    expect(JSON.stringify(page.body)).not.toMatch(/tokenHash|securityVersion|password/);
    expect(JSON.stringify(page.body)).not.toContain(created.token);
    expect(JSON.stringify(await prisma.identityReplay.findMany())).not.toContain(created.token);
    const revokeKey = uuidv7();
    await resetLimits();
    await post(`/${created.id}/revoke`, { password }).set('Idempotency-Key', revokeKey).expect(204);
    await resetLimits();
    await post(`/${created.id}/revoke`, { password })
      .set('Idempotency-Key', revokeKey)
      .expect(204)
      .expect('Idempotency-Replayed', 'true');
    await http()
      .get('/api/v1/auth/session')
      .set('Authorization', `Bearer ${created.token}`)
      .expect(401);
    await resetLimits();
    const expired = await post('', body).set('Idempotency-Key', key).expect(409);
    expect(JSON.stringify(expired.body)).not.toContain(created.token);
  });

  it('requires session, Origin, CSRF and password; bearer credentials cannot manage credentials', async () => {
    const body = payload();
    await http().get('/api/v1/api-tokens').expect(401);
    await http().post('/api/v1/api-tokens').set('Cookie', current.cookie).send(body).expect(403);
    await http()
      .post('/api/v1/api-tokens')
      .set('Origin', origin)
      .set('Cookie', current.cookie)
      .send(body)
      .expect(401);
    await post('', { ...body, password: 'wrong fixture password' }).expect(401);
    await resetLimits();
    const created = (await post('', body).expect(201)).body as { id: string; token: string };
    await http()
      .get('/api/v1/api-tokens')
      .set('Cookie', current.cookie)
      .set('Authorization', `Bearer ${created.token}`)
      .expect(401);
    await http()
      .post(`/api/v1/api-tokens/${created.id}/revoke`)
      .set('Authorization', `Bearer ${created.token}`)
      .send({ password })
      .expect(401);
  });

  it('rejects cross-owner access and reuse of a creation key by another account', async () => {
    const body = payload();
    const key = uuidv7();
    const created = (await post('', body).set('Idempotency-Key', key).expect(201)).body as {
      id: string;
      token: string;
    };
    const other = await browser();
    await resetLimits();
    await post(`/${created.id}/revoke`, { password }, other).expect(404);
    await resetLimits();
    const denied = await post('', body, other).set('Idempotency-Key', key).expect(409);
    expect(JSON.stringify(denied.body)).not.toContain(created.token);
    expect(
      (await http().get('/api/v1/api-tokens').set('Cookie', other.cookie).expect(200)).body,
    ).toEqual({ items: [], nextCursor: null });
  });

  it('rejects malformed scopes, names, dates, cursors and quota abuse', async () => {
    for (const invalid of [
      { ...payload(), scopes: [{ permission: '*' }] },
      { ...payload(), scopes: [] },
      { ...payload(), scopes: [{ permission: 'profile.read', unexpected: true }] },
      { ...payload(), name: '\nAutomation' },
      { ...payload(), expiresAt: 'invalid' },
    ]) {
      await resetLimits();
      await post('', invalid).expect(400);
    }
    await resetLimits();
    await post('', {
      ...payload(),
      scopes: [{ permission: 'node.manage', organizationId: uuidv7() }],
    }).expect(403);
    await list('?limit=101').expect(400);
    await list('?limit=0').expect(400);
    await list('?cursor=invalid').expect(400);
    await resetLimits();
    await post('', { ...payload(), password: 'wrong fixture password' }).expect(401);
    await prisma.$executeRaw`UPDATE identity_throttles SET next_allowed_at = ${new Date(Date.now() + 60000)} WHERE next_allowed_at > created_at`;
    await post('', payload()).expect(429);
  });

  it('returns no credential and stores no retry result when auditing creation fails', async () => {
    const body = payload();
    const key = uuidv7();
    const stop = fixture.app
      .get(DomainEventBus)
      .subscribe(() => Promise.reject(new Error('injected audit failure')));
    try {
      await post('', body).set('Idempotency-Key', key).expect(503);
    } finally {
      stop();
    }
    expect(await prisma.apiToken.count({ where: { userId: current.id } })).toBe(0);
    await resetLimits();
    await post('', body)
      .set('Idempotency-Key', key)
      .expect(201)
      .expect('Idempotency-Replayed', 'false');
  });
});
