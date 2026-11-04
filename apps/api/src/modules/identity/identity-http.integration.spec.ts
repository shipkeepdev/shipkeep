import type { Server } from 'node:http';

import request from 'supertest';

import { AppConfig } from '../../platform/config/app-config';
import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { integrationApp } from '../../testing/integration-app';
import { smtpServer, type SmtpFixture } from '../../testing/smtp-server';

describe('identity HTTP acceptance with PostgreSQL and TLS SMTP', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let smtp: SmtpFixture;
  let close: (() => Promise<void>) | undefined;
  let closeSmtp: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  const previous: Record<string, string | undefined> = {};
  const origin = 'https://shipkeep.example.com';
  const password = 'correct horse HTTP test password';
  const http = () => request(fixture.app.getHttpServer() as Server);
  const post = (path: string, body: object) =>
    http().post(`/api/v1/auth/${path}`).set('Origin', origin).send(body);

  beforeAll(async () => {
    smtp = await smtpServer();
    closeSmtp = smtp.close;
    const env = {
      API_PUBLIC_URL: origin,
      SMTP_HOST: 'localhost',
      SMTP_PORT: String(smtp.port),
      SMTP_FROM: 'notifications@example.com',
      SMTP_CA_FILE: smtp.caFile,
    };
    for (const [key, value] of Object.entries(env)) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }
    fixture = await integrationApp();
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
  });
  afterAll(async () => {
    try {
      await close?.();
    } finally {
      await closeSmtp?.();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
  beforeEach(async () => {
    await prisma.identityThrottle.deleteMany();
  });

  async function mailCode(index: number): Promise<string> {
    await vi.waitFor(
      () => {
        expect(smtp.messages.length).toBeGreaterThan(index);
      },
      { timeout: 8000 },
    );
    const code = smtp.messages[index].match(/^[A-Za-z0-9_-]{43}$/m)?.[0];
    if (!code) throw new Error('missing code in SMTP fixture');
    return code;
  }

  function credentials(response: { headers: Record<string, unknown> }) {
    const values = response.headers['set-cookie'];
    if (
      !Array.isArray(values) ||
      !values.every((value): value is string => typeof value === 'string')
    )
      throw new Error('missing cookies');
    expect(values).toHaveLength(2);
    for (const cookie of values)
      expect(cookie).toMatch(/; Path=\/; Expires=.*; (HttpOnly; )?Secure; SameSite=Strict/);
    const session = values
      .find((value) => value.startsWith('__Host-shipkeep_session='))
      ?.split(';')[0];
    const csrf = values
      .find((value) => value.startsWith('__Host-shipkeep_csrf='))
      ?.split(';')[0]
      .split('=')[1];
    if (!session || !csrf) throw new Error('incomplete cookies');
    return { session, csrf };
  }

  it('signs up, verifies over SMTP, rotates sessions, resets the password and logs out', async () => {
    const email = 'flow@example.com';
    const message = smtp.messages.length;
    await post('register', { email, password }).expect(202).expect('Cache-Control', 'no-store');
    await post('login', { email, password }).expect(401);
    await post('verify', { token: await mailCode(message) }).expect(204);
    await prisma.identityThrottle.deleteMany();
    await post('verify', { token: await mailCode(message) }).expect(401);
    const first = await post('login', { email, password }).expect(200);
    expect(first.body).toEqual({
      userId: expect.any(String),
      email,
      expiresAt: expect.any(String),
    });
    const a = credentials(first);
    await http().get('/api/v1/auth/session').set('Cookie', a.session).expect(200);
    await post('logout', {}).set('Cookie', a.session).expect(401);
    const second = credentials(
      await post('login', { email, password }).set('Cookie', a.session).expect(200),
    );
    await http().get('/api/v1/auth/session').set('Cookie', a.session).expect(401);
    const resetMessage = smtp.messages.length;
    await post('reset/request', { email }).expect(202);
    const replacement = 'replacement HTTP test passphrase';
    await post('reset', { token: await mailCode(resetMessage), password: replacement }).expect(204);
    await http().get('/api/v1/auth/session').set('Cookie', second.session).expect(401);
    const final = credentials(await post('login', { email, password: replacement }).expect(200));
    const logout = await post('logout', {})
      .set('Cookie', final.session)
      .set('X-Shipkeep-CSRF', final.csrf)
      .expect(204);
    expect(JSON.stringify(logout.headers['set-cookie'])).toContain('01 Jan 1970');
    await http().get('/api/v1/auth/session').set('Cookie', final.session).expect(401);
    const audit = await prisma.auditEvent.findMany({
      where: { targetId: (first.body as { userId: string }).userId },
    });
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'identity.registered',
        'identity.email_verified',
        'identity.logged_in',
        'identity.password_reset',
        'identity.logged_out',
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain(password);
    expect(JSON.stringify(audit)).not.toContain(final.csrf);
  });

  it('keeps account existence private and rate-limits before expensive password work', async () => {
    const missing = await post('reset/request', { email: 'missing@example.com' }).expect(202);
    const known = await post('reset/request', { email: 'flow@example.com' }).expect(202);
    expect(missing.body).toEqual(known.body);
    await post('login', { email: 'missing@example.com', password }).expect(401);
    // Keep the persisted subject delay active independently of this machine's Argon2 latency.
    await prisma.$executeRaw`UPDATE identity_throttles SET next_allowed_at = ${new Date(Date.now() + 60000)}
      WHERE next_allowed_at > created_at`;
    const blocked = await post('login', { email: 'missing@example.com', password }).expect(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['cache-control']).toBe('no-store');
    await post('register', { email: 'invalid@example.com', password, admin: true }).expect(400);
    await post('register', { email: 'invalid@example.com', password: 'x'.repeat(17000) }).expect(
      413,
    );
    await http()
      .post('/api/v1/auth/register')
      .send({ email: 'cross-site@example.com', password })
      .expect(403);
    expect(await prisma.user.count({ where: { email: 'cross-site@example.com' } })).toBe(0);
  });

  it('rolls back HTTP registration when audit fails and rejects unavailable mail configuration', async () => {
    const stop = fixture.app
      .get(DomainEventBus)
      .subscribe(() => Promise.reject(new Error('injected audit failure')));
    try {
      await post('register', { email: 'rollback@example.com', password }).expect(503);
      expect(await prisma.user.count({ where: { email: 'rollback@example.com' } })).toBe(0);
    } finally {
      stop();
    }
    const config = fixture.app.get(AppConfig);
    const get = config.get.bind(config);
    const spy = vi
      .spyOn(config, 'get')
      .mockImplementation((key) => (key === 'SMTP_HOST' ? undefined : get(key)));
    try {
      await post('register', { email: 'unconfigured@example.com', password }).expect(503);
      expect(await prisma.user.count({ where: { email: 'unconfigured@example.com' } })).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
