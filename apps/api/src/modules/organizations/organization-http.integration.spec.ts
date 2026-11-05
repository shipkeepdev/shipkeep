import type { Server } from 'node:http';

import { Secret } from '@shipkeep/domain';
import { TOTP } from 'otpauth';
import { Client } from 'pg';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';

import { AppConfig } from '../../platform/config/app-config';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { auditLog } from '../../testing/audit-log';
import { integrationApp } from '../../testing/integration-app';
import { ApiTokenCommands } from '../identity/application/api-token-commands';
import { PASSWORD_HASHER, type PasswordHashing } from '../identity/application/identity-ports';
import { MfaCommands, type SecurityContext } from '../identity/application/mfa-commands';
import { SessionCommands, type SessionGrant } from '../identity/application/session-commands';
import { cookiePolicy } from '../identity/interface/session-http';

describe('organization mutations over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  let admin: Client;
  let closeAdmin: (() => Promise<void>) | undefined;
  let hash: Secret;
  let origin: string;
  let actor: SecurityContext;
  let cookie: string;
  let csrf: string;
  const password = new Secret('organization HTTP fixture passphrase');
  const http = () => request(fixture.app.getHttpServer() as Server);
  const post = (path: string, body: object) =>
    http()
      .post(`/api/v1/organizations${path}`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .set('X-Shipkeep-CSRF', csrf)
      .send(body);
  const resetLimits = () => prisma.identityThrottle.deleteMany();
  const payload = () => ({
    name: 'HTTP organization',
    slug: `http-${actor.userId.slice(-12)}`,
    password: password.expose(),
  });
  function acceptGrant(grant: SessionGrant) {
    cookie = `${cookiePolicy(origin).name}=${grant.token.expose()}`;
    csrf = grant.csrf.expose();
  }
  function acceptCookies(response: request.Response) {
    const values = response.headers['set-cookie'] as unknown;
    if (!Array.isArray(values) || values.some((value: unknown) => typeof value !== 'string'))
      throw new Error('Missing fixture cookies.');
    const policy = cookiePolicy(origin);
    const pairs = (values as string[]).map((value) => value.split(';')[0]);
    const session = pairs.find((value) => value.startsWith(`${policy.name}=`));
    const proof = pairs.find((value) => value.startsWith(`${policy.csrfName}=`));
    if (!session || !proof) throw new Error('Incomplete fixture cookies.');
    cookie = session;
    csrf = proof.slice(policy.csrfName.length + 1);
    actor = { ...actor, securityVersion: actor.securityVersion + 1 };
  }
  async function create() {
    const result = await post('', payload()).expect(201);
    acceptCookies(result);
    return (result.body as { organization: { id: string } }).organization.id;
  }
  beforeAll(async () => {
    fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    closeAdmin = () => admin.end();
    origin = new URL(fixture.app.get(AppConfig).get('API_PUBLIC_URL')).origin;
    hash = await fixture.app.get<PasswordHashing>(PASSWORD_HASHER).hash(password);
  });
  afterAll(async () => {
    await closeAdmin?.();
    await close?.();
  });
  beforeEach(async () => {
    await resetLimits();
    const userId = uuidv7();
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.com`,
        passwordHash: hash.expose(),
        status: 'active',
        emailVerifiedAt: new Date(),
      },
    });
    actor = { userId, securityVersion: 0, ip: '127.0.0.1', userAgent: 'Organization HTTP' };
    acceptGrant(
      await fixture.app.get(SessionCommands).login({
        email: `${userId}@example.com`,
        password,
        ip: actor.ip,
        userAgent: actor.userAgent,
      }),
    );
  });

  it('creates ownership, rotates cookies and returns only organization and session metadata', async () => {
    const previous = cookie;
    const key = uuidv7();
    const body = payload();
    const result = await post('', body)
      .set('Idempotency-Key', key)
      .expect(201)
      .expect('Cache-Control', 'no-store');
    const created = result.body as { organization: { id: string }; session: { userId: string } };
    expect(created.session.userId).toBe(actor.userId);
    expect(Object.keys(result.body as object).sort()).toEqual(['organization', 'session']);
    expect(/passwordHash|securityVersion|"token"|"csrf"/.test(JSON.stringify(result.body))).toBe(
      false,
    );
    expect(JSON.stringify(result.body).includes(password.expose())).toBe(false);
    acceptCookies(result);
    expect(cookie === previous).toBe(false);
    await http().get('/api/v1/auth/session').set('Cookie', previous).expect(401);
    await http().get('/api/v1/auth/session').set('Cookie', cookie).expect(200);
    await http()
      .get(`/api/v1/organizations/${created.organization.id}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(
      await auditLog().count({
        where: { action: 'organization.created', targetId: created.organization.id },
      }),
    ).toBe(1);
    await resetLimits();
    await post('', body).set('Idempotency-Key', key).expect(409);
  });

  it('requires session, origin, CSRF, password and the configured second factor', async () => {
    await http().post('/api/v1/organizations').set('Origin', origin).send(payload()).expect(401);
    await http().post('/api/v1/organizations').set('Cookie', cookie).send(payload()).expect(403);
    await http()
      .post('/api/v1/organizations')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .send(payload())
      .expect(401);
    await post('', { ...payload(), password: 'incorrect fixture passphrase' }).expect(401);
    const mfa = fixture.app.get(MfaCommands);
    const setup = await mfa.setup(actor, password);
    const enabled = await mfa.enable(
      actor,
      password,
      new Secret(new TOTP({ secret: setup.secret.expose() }).generate()),
    );
    acceptGrant(enabled.session);
    actor = { ...actor, securityVersion: 1 };
    await resetLimits();
    await post('', payload()).expect(401);
    await resetLimits();
    const success = await post('', {
      ...payload(),
      recovery: enabled.recoveryCodes[0].expose(),
    }).expect(201);
    acceptCookies(success);
    expect(await prisma.user.findUnique({ where: { id: actor.userId } })).toMatchObject({
      securityVersion: 2,
    });
  });

  it('updates settings with scoped tokens, audits their identity and replays only the same request', async () => {
    const id = await create();
    const commands = fixture.app.get(ApiTokenCommands);
    const grant = await commands.create(
      actor,
      {
        name: 'Settings',
        scopes: [{ permission: 'organization.update', organizationId: id }],
        expiresAt: new Date(Date.now() + 3600000),
      },
      password,
      {},
    );
    const key = uuidv7();
    const body = { name: '  Updated organization  ', slug: payload().slug };
    const update = (input = body) =>
      http()
        .post(`/api/v1/organizations/${id}/settings`)
        .set('Authorization', `Bearer ${grant.token.expose()}`)
        .set('Idempotency-Key', key)
        .send(input);
    expect((await update().expect(200).expect('Idempotency-Replayed', 'false')).body).toMatchObject(
      { id, name: 'Updated organization' },
    );
    await update().expect(200).expect('Idempotency-Replayed', 'true');
    await update({ ...body, name: 'Different' }).expect(409);
    expect(
      await auditLog().findFirst({
        where: { action: 'organization.updated', targetId: id },
      }),
    ).toMatchObject({ actorKind: 'api_token', actorId: grant.metadata.id });
    expect(
      await auditLog().count({ where: { action: 'organization.updated', targetId: id } }),
    ).toBe(1);
    await http()
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${grant.token.expose()}`)
      .send(payload())
      .expect(401);
    await commands.revoke(actor, grant.metadata.id, password, {});
    await update().expect(401);
  });

  it('validates settings, protects browser writes and returns stable slug conflicts', async () => {
    const id = await create();
    const body = { name: 'Updated', slug: payload().slug };
    await http()
      .post(`/api/v1/organizations/${id}/settings`)
      .set('Cookie', cookie)
      .send(body)
      .expect(403);
    await http()
      .post(`/api/v1/organizations/${id}/settings`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .send(body)
      .expect(401);
    for (const input of [
      { ...body, organizationId: uuidv7() },
      { ...body, name: '\u0000' },
      { ...body, name: 'x'.repeat(81) },
      { ...body, slug: 'trailing\n' },
      { ...body, slug: null },
    ])
      await post(`/${id}/settings`, input).expect(400);
    await post(`/${uuidv7()}/settings`, body).expect(404);
    await resetLimits();
    const second = await post('', {
      ...payload(),
      slug: `second-${actor.userId.slice(-12)}`,
    }).expect(201);
    acceptCookies(second);
    const collision = await post(`/${id}/settings`, {
      ...body,
      slug: `second-${actor.userId.slice(-12)}`,
    }).expect(409);
    expect(collision.body).toMatchObject({ code: 'organization_slug_unavailable' });
  });

  it('sends no rotated cookies and rolls back ownership when retry persistence or audit fails', async () => {
    for (const constraint of ['retry', 'audit'] as const) {
      await resetLimits();
      if (constraint === 'retry')
        await admin.query(
          'ALTER TABLE identity_replays ADD CONSTRAINT organization_retry_failure CHECK (false) NOT VALID',
        );
      else
        await admin.query(
          "ALTER TABLE audit_events ADD CONSTRAINT organization_audit_failure CHECK (action <> 'organization.created') NOT VALID",
        );
      try {
        const result = await post('', payload()).set('Idempotency-Key', uuidv7()).expect(503);
        const returnedCookies: unknown = result.headers['set-cookie'];
        expect(returnedCookies === undefined).toBe(true);
      } finally {
        if (constraint === 'retry')
          await admin.query(
            'ALTER TABLE identity_replays DROP CONSTRAINT organization_retry_failure',
          );
        else
          await admin.query('ALTER TABLE audit_events DROP CONSTRAINT organization_audit_failure');
      }
      expect(await prisma.user.findUnique({ where: { id: actor.userId } })).toMatchObject({
        securityVersion: 0,
      });
      const rows = await admin.query<{ count: string }>(
        'SELECT count(*) FROM organizations WHERE slug = $1',
        [payload().slug],
      );
      expect(rows.rows[0]?.count).toBe('0');
      await http().get('/api/v1/auth/session').set('Cookie', cookie).expect(200);
    }
  });
});
