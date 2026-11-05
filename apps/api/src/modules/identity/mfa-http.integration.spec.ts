import type { Server } from 'node:http';

import { Secret } from '@shipkeep/domain';
import * as OTPAuth from 'otpauth';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { integrationApp } from '../../testing/integration-app';

import { PASSWORD_HASHER, type PasswordHashing } from './application/identity-ports';
import { IDENTITY_STORE, type IdentityStore } from './application/identity-store';
import { SessionCommands } from './application/session-commands';

interface BrowserSession {
  cookie: string;
  csrf: string;
}
describe('MFA HTTP acceptance', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  let current: BrowserSession;
  let userId: string;
  let email: string;
  const origin = 'https://shipkeep.example.com';
  const password = 'correct horse MFA HTTP password';
  const previous: Record<string, string | undefined> = {};
  const http = () => request(fixture.app.getHttpServer() as Server);
  const post = (path: string, body: object) =>
    http().post(`/api/v1/auth/${path}`).set('Origin', origin).send(body);
  const mutate = (path: string, body: object, session = current) =>
    post(`mfa/${path}`, body).set('Cookie', session.cookie).set('X-Shipkeep-CSRF', session.csrf);
  // User-driven MFA steps normally take time. Separate steps from the dedicated throttle test.
  const resetLimits = () => prisma.identityThrottle.deleteMany();
  const code = (secret: string) =>
    new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(secret),
      digits: 6,
      period: 30,
      algorithm: 'SHA1',
    }).generate();

  beforeAll(async () => {
    for (const [key, value] of Object.entries({
      API_PUBLIC_URL: origin,
      TRUST_PROXY: 'loopback',
    })) {
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
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
  beforeEach(async () => {
    await resetLimits();
    const user = await browser();
    current = user.session;
    userId = user.id;
    email = user.email;
  });
  function cookies(response: { headers: Record<string, unknown> }): BrowserSession {
    const values = response.headers['set-cookie'];
    if (
      !Array.isArray(values) ||
      !values.every((value): value is string => typeof value === 'string')
    )
      throw new Error('missing cookies');
    const cookie = values
      .find((value) => value.startsWith('__Host-shipkeep_session='))
      ?.split(';')[0];
    const csrf = values
      .find((value) => value.startsWith('__Host-shipkeep_csrf='))
      ?.split(';')[0]
      .split('=')[1];
    if (!cookie || !csrf) throw new Error('incomplete cookies');
    return { cookie, csrf };
  }
  async function browser() {
    const id = uuidv7();
    const email = `${id}@example.com`;
    const now = new Date();
    await fixture.app.get<IdentityStore>(IDENTITY_STORE).insertUser({
      id,
      email,
      passwordHash: await fixture.app
        .get<PasswordHashing>(PASSWORD_HASHER)
        .hash(new Secret(password)),
      status: 'active',
      emailVerifiedAt: now,
      securityVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { id, email, session: cookies(await post('login', { email, password }).expect(200)) };
  }
  async function setup() {
    const result = await mutate('setup', { password })
      .expect(200)
      .expect('Cache-Control', 'no-store');
    return result.body as { secret: string; provisioningUri: string; expiresAt: string };
  }

  it('activates MFA, requires login proof, regenerates recovery codes and disables MFA', async () => {
    const original = current;
    const pending = await setup();
    expect(pending.provisioningUri).toContain('otpauth://totp/');
    await resetLimits();
    const enabled = await mutate('enable', { password, totp: code(pending.secret) }).expect(200);
    const recovery = (enabled.body as { recoveryCodes: string[] }).recoveryCodes;
    expect(recovery).toHaveLength(10);
    current = cookies(enabled);
    await http().get('/api/v1/auth/session').set('Cookie', original.cookie).expect(401);
    const status = await http().get('/api/v1/auth/mfa').set('Cookie', current.cookie).expect(200);
    expect(status.body).toEqual({
      enabled: true,
      pendingExpiresAt: null,
      recoveryCodesRemaining: 10,
    });
    expect(JSON.stringify(status.body)).not.toContain(pending.secret);
    await post('login', { email, password }).expect(401);
    await resetLimits();
    current = cookies(await post('login', { email, password, recovery: recovery[0] }).expect(200));
    await post('login', { email, password, recovery: recovery[0] }).expect(401);
    await resetLimits();
    const beforeRotation = current;
    const replaced = await mutate('recovery', { password, recovery: recovery[1] }).expect(200);
    current = cookies(replaced);
    const nextCodes = (replaced.body as { recoveryCodes: string[] }).recoveryCodes;
    expect(nextCodes).toHaveLength(10);
    expect(nextCodes).not.toContain(recovery[1]);
    await http().get('/api/v1/auth/session').set('Cookie', beforeRotation.cookie).expect(401);
    await resetLimits();
    current = cookies(await mutate('disable', { password, recovery: nextCodes[0] }).expect(200));
    const disabled = await http().get('/api/v1/auth/mfa').set('Cookie', current.cookie).expect(200);
    expect(disabled.body).toEqual({
      enabled: false,
      pendingExpiresAt: null,
      recoveryCodesRemaining: 0,
    });
    await post('login', { email, password }).expect(200);
  });

  it('requires Origin/CSRF and binds secret-bearing retries to the account and security version', async () => {
    await http().get('/api/v1/auth/mfa').expect(401);
    await http()
      .post('/api/v1/auth/mfa/setup')
      .set('Cookie', current.cookie)
      .send({ password })
      .expect(403);
    await post('mfa/setup', { password }).set('Cookie', current.cookie).expect(401);
    const key = uuidv7();
    const first = await mutate('setup', { password }).set('Idempotency-Key', key).expect(200);
    await resetLimits();
    const repeated = await mutate('setup', { password }).set('Idempotency-Key', key).expect(200);
    expect(repeated.body).toEqual(first.body);
    const other = await browser();
    await resetLimits();
    const conflict = await mutate('setup', { password }, other.session)
      .set('Idempotency-Key', key)
      .expect(409);
    expect(JSON.stringify(conflict.body)).not.toContain((first.body as { secret: string }).secret);
    const rotated = await fixture.app
      .get(SessionCommands)
      .rotateAuthenticated(userId, 0, { ip: '127.0.0.1', userAgent: 'fixture' });
    current = {
      cookie: `__Host-shipkeep_session=${rotated.token.expose()}`,
      csrf: rotated.csrf.expose(),
    };
    await resetLimits();
    await mutate('setup', { password }).set('Idempotency-Key', key).expect(409);
  });

  it('enforces the account limit across trusted proxy IP changes before password work', async () => {
    await mutate('setup', { password: 'wrong MFA HTTP password' })
      .set('X-Forwarded-For', '198.51.100.10')
      .expect(401);
    await prisma.$executeRaw`UPDATE identity_throttles SET next_allowed_at = ${new Date(Date.now() + 60000)} WHERE next_allowed_at > created_at`;
    const verify = vi.spyOn(fixture.app.get<PasswordHashing>(PASSWORD_HASHER), 'verify');
    try {
      await mutate('setup', { password }).set('X-Forwarded-For', '198.51.100.11').expect(429);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
    }
  });

  it('rolls back activation/cookies on audit failure and rejects malformed factor input', async () => {
    const pending = await setup();
    await resetLimits();
    await mutate('enable', { password, totp: null }).expect(400);
    await resetLimits();
    const key = uuidv7();
    const totp = code(pending.secret);
    const stop = fixture.app
      .get(DomainEventBus)
      .subscribe(() => Promise.reject(new Error('injected audit failure')));
    try {
      const failed = await mutate('enable', { password, totp })
        .set('Idempotency-Key', key)
        .expect(503);
      expect(failed.headers['set-cookie']).toBeUndefined();
    } finally {
      stop();
    }
    expect(
      (await http().get('/api/v1/auth/mfa').set('Cookie', current.cookie).expect(200)).body,
    ).toMatchObject({ enabled: false });
    await resetLimits();
    const enabled = await mutate('enable', { password, totp })
      .set('Idempotency-Key', key)
      .expect(200);
    expect((enabled.body as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);
  });
});
