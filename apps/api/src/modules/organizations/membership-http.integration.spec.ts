import type { Server } from 'node:http';

import { Secret } from '@shipkeep/domain';
import { Client } from 'pg';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';

import { AppConfig } from '../../platform/config/app-config';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { integrationApp } from '../../testing/integration-app';
import { ApiTokenCommands } from '../identity/application/api-token-commands';
import { PASSWORD_HASHER, type PasswordHashing } from '../identity/application/identity-ports';
import type { SecurityContext } from '../identity/application/mfa-commands';
import { SessionCommands } from '../identity/application/session-commands';
import { cookiePolicy } from '../identity/interface/session-http';

interface Browser {
  context: SecurityContext;
  email: string;
  cookie: string;
  csrf: string;
}
interface MutationBody {
  membership: { id: string; userId: string; orgRole: string } | null;
  session?: { userId: string };
}

describe('membership mutations over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  let admin: Client;
  let closeAdmin: (() => Promise<void>) | undefined;
  let hash: Secret;
  let origin: string;
  let owner: Browser;
  let subject: Browser;
  let organizationId: string;
  const password = new Secret('membership HTTP fixture passphrase');
  const http = () => request(fixture.app.getHttpServer() as Server);
  const resetLimits = () => prisma.identityThrottle.deleteMany();
  const post = (browser: Browser, path: string, body: object) =>
    http()
      .post(`/api/v1/organizations${path}`)
      .set('Origin', origin)
      .set('Cookie', browser.cookie)
      .set('X-Shipkeep-CSRF', browser.csrf)
      .send(body);
  const path = (suffix = '') => `/${organizationId}/members${suffix}`;
  const proof = { password: password.expose() };

  function acceptCookies(browser: Browser, response: request.Response): void {
    const values = response.headers['set-cookie'] as unknown;
    if (!Array.isArray(values) || values.some((value: unknown) => typeof value !== 'string'))
      throw new Error('Missing fixture cookies.');
    const policy = cookiePolicy(origin);
    const pairs = (values as string[]).map((value) => value.split(';')[0]);
    const session = pairs.find((value) => value.startsWith(`${policy.name}=`));
    const csrf = pairs.find((value) => value.startsWith(`${policy.csrfName}=`));
    if (!session || !csrf) throw new Error('Incomplete fixture cookies.');
    browser.cookie = session;
    browser.csrf = csrf.slice(policy.csrfName.length + 1);
    browser.context = { ...browser.context, securityVersion: browser.context.securityVersion + 1 };
  }
  async function account(label: string): Promise<Browser> {
    const userId = uuidv7();
    const email = `${userId}@example.com`;
    await prisma.user.create({
      data: {
        id: userId,
        email,
        passwordHash: hash.expose(),
        status: 'active',
        emailVerifiedAt: new Date(),
      },
    });
    const context = { userId, securityVersion: 0, ip: '127.0.0.1', userAgent: label };
    const grant = await fixture.app
      .get(SessionCommands)
      .login({ email, password, ip: context.ip, userAgent: label });
    return {
      context,
      email,
      cookie: `${cookiePolicy(origin).name}=${grant.token.expose()}`,
      csrf: grant.csrf.expose(),
    };
  }
  const session = (browser: Browser) =>
    http().get('/api/v1/auth/session').set('Cookie', browser.cookie);
  // Tenant tables are under row-level security: the restricted Prisma client sees no rows
  // outside a tenant transaction, so assertions read them through the administrative login.
  const count = async (sql: string, values: readonly unknown[]): Promise<number> =>
    Number((await admin.query<{ count: string }>(sql, [...values])).rows[0]?.count ?? -1);
  async function ownMembership(): Promise<string> {
    const rows = await admin.query<{ id: string }>(
      'SELECT id FROM memberships WHERE organization_id = $1 AND user_id = $2',
      [organizationId, owner.context.userId],
    );
    const id = rows.rows[0]?.id;
    if (!id) throw new Error('Missing owner membership fixture.');
    return id;
  }
  const audits = (action: string, targetId: string) =>
    prisma.auditEvent.count({ where: { action, targetId } });

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
    owner = await account('Membership owner');
    subject = await account('Membership subject');
    const created = await post(owner, '', {
      name: 'Membership HTTP',
      slug: `members-${owner.context.userId.slice(-12)}`,
      ...proof,
    }).expect(201);
    acceptCookies(owner, created);
    organizationId = (created.body as { organization: { id: string } }).organization.id;
    await resetLimits();
  });

  it('adds a member once, invalidates their sessions and replays only the same request', async () => {
    const key = uuidv7();
    const body = { email: subject.email, role: 'member', ...proof };
    const first = await post(owner, path(), body)
      .set('Idempotency-Key', key)
      .expect(201)
      .expect('Cache-Control', 'no-store')
      .expect('Idempotency-Replayed', 'false');
    const added = first.body as MutationBody;
    expect(added.membership).toMatchObject({ userId: subject.context.userId, orgRole: 'member' });
    expect(added.session === undefined).toBe(true);
    expect(JSON.stringify(first.body).includes(password.expose())).toBe(false);
    const cookies: unknown = first.headers['set-cookie'];
    expect(cookies === undefined).toBe(true);
    await session(subject).expect(401);
    await session(owner).expect(200);

    await resetLimits();
    const replay = await post(owner, path(), body)
      .set('Idempotency-Key', key)
      .expect(201)
      .expect('Idempotency-Replayed', 'true');
    expect(replay.body).toEqual(first.body);
    await resetLimits();
    await post(owner, path(), { ...body, role: 'admin' })
      .set('Idempotency-Key', key)
      .expect(409);
    const id = added.membership?.id ?? '';
    expect(await audits('membership.added', id)).toBe(1);
  });

  it('requires a browser session, origin, CSRF and the password, and rejects bearer tokens', async () => {
    const body = { email: subject.email, role: 'member', ...proof };
    await http()
      .post(`/api/v1/organizations${path()}`)
      .set('Origin', origin)
      .send(body)
      .expect(401);
    await http()
      .post(`/api/v1/organizations${path()}`)
      .set('Cookie', owner.cookie)
      .send(body)
      .expect(403);
    await http()
      .post(`/api/v1/organizations${path()}`)
      .set('Cookie', owner.cookie)
      .set('Origin', origin)
      .send(body)
      .expect(401);
    await post(owner, path(), { ...body, password: 'incorrect fixture passphrase' }).expect(401);
    await resetLimits();
    const grant = await fixture.app.get(ApiTokenCommands).create(
      owner.context,
      {
        name: 'Members',
        scopes: [{ permission: 'member.manage', organizationId }],
        expiresAt: new Date(Date.now() + 3600000),
      },
      password,
      {},
    );
    await http()
      .post(`/api/v1/organizations${path()}`)
      .set('Authorization', `Bearer ${grant.token.expose()}`)
      .send(body)
      .expect(401);
    for (const input of [
      { ...body, role: 'superuser' },
      { ...body, email: 'not-an-address' },
      { ...body, organizationId: uuidv7() },
      { email: subject.email, role: 'member' },
    ])
      await post(owner, path(), input).expect(400);
    await post(owner, path(`/${uuidv7()}/role`), { role: 'admin', ...proof }).expect(404);
    await post(owner, path('/invalid/role'), { role: 'admin', ...proof }).expect(400);
    expect(
      await count('SELECT count(*) FROM memberships WHERE organization_id = $1', [organizationId]),
    ).toBe(1);
  });

  it('answers an unknown address like a hidden one and records nothing', async () => {
    await post(owner, path(), {
      email: `${uuidv7()}@example.com`,
      role: 'member',
      ...proof,
    }).expect(404);
    await resetLimits();
    await post(owner, path(), {
      email: `${uuidv7()}@example.com`,
      role: 'member',
      password: 'incorrect fixture passphrase',
    }).expect(401);
    expect(
      await prisma.auditEvent.count({ where: { organizationId, action: 'membership.added' } }),
    ).toBe(0);
  });

  it('changes roles, protects the last owner and rotates the caller after a self-demotion', async () => {
    const added = await post(owner, path(), {
      email: subject.email,
      role: 'member',
      ...proof,
    }).expect(201);
    const membershipId = (added.body as MutationBody).membership?.id ?? '';
    await resetLimits();
    const promoted = await post(owner, path(`/${membershipId}/role`), {
      role: 'owner',
      ...proof,
    }).expect(200);
    expect((promoted.body as MutationBody).membership).toMatchObject({ orgRole: 'owner' });
    expect(await audits('membership.role_changed', membershipId)).toBe(1);

    const own = { id: await ownMembership() };
    await resetLimits();
    const previous = owner.cookie;
    const demoted = await post(owner, path(`/${own.id}/role`), { role: 'admin', ...proof }).expect(
      200,
    );
    expect((demoted.body as MutationBody).session).toMatchObject({ userId: owner.context.userId });
    acceptCookies(owner, demoted);
    await session({ ...owner, cookie: previous }).expect(401);
    await session(owner).expect(200);
    expect(await audits('membership.role_changed', own.id)).toBe(1);
  });

  it('refuses to demote the last owner', async () => {
    const own = { id: await ownMembership() };
    const conflict = await post(owner, path(`/${own.id}/role`), {
      role: 'member',
      ...proof,
    }).expect(409);
    expect(conflict.body).toMatchObject({ code: 'last_organization_owner' });
    await session(owner).expect(200);
  });

  it('removes a member, replays the removal and denies members without authority', async () => {
    const added = await post(owner, path(), {
      email: subject.email,
      role: 'member',
      ...proof,
    }).expect(201);
    const membershipId = (added.body as MutationBody).membership?.id ?? '';
    const relogin = await fixture.app.get(SessionCommands).login({
      email: subject.email,
      password,
      ip: '127.0.0.1',
      userAgent: 'Membership subject',
    });
    subject.cookie = `${cookiePolicy(origin).name}=${relogin.token.expose()}`;
    subject.csrf = relogin.csrf.expose();
    await resetLimits();
    await post(subject, path(`/${membershipId}/remove`), proof).expect(404);

    await resetLimits();
    const key = uuidv7();
    const removed = await post(owner, path(`/${membershipId}/remove`), proof)
      .set('Idempotency-Key', key)
      .expect(200);
    expect(removed.body).toEqual({ membership: null });
    await resetLimits();
    await post(owner, path(`/${membershipId}/remove`), proof)
      .set('Idempotency-Key', key)
      .expect(200)
      .expect('Idempotency-Replayed', 'true');
    expect(await audits('membership.removed', membershipId)).toBe(1);
    expect(await count('SELECT count(*) FROM memberships WHERE id = $1', [membershipId])).toBe(0);
  });

  it('rolls back the membership and keeps sessions when the audit or retry write fails', async () => {
    for (const constraint of ['retry', 'audit'] as const) {
      await resetLimits();
      if (constraint === 'retry')
        await admin.query(
          'ALTER TABLE identity_replays ADD CONSTRAINT membership_retry_failure CHECK (false) NOT VALID',
        );
      else
        await admin.query(
          "ALTER TABLE audit_events ADD CONSTRAINT membership_audit_failure CHECK (action <> 'membership.added') NOT VALID",
        );
      try {
        await post(owner, path(), { email: subject.email, role: 'member', ...proof })
          .set('Idempotency-Key', uuidv7())
          .expect(503);
      } finally {
        if (constraint === 'retry')
          await admin.query(
            'ALTER TABLE identity_replays DROP CONSTRAINT membership_retry_failure',
          );
        else await admin.query('ALTER TABLE audit_events DROP CONSTRAINT membership_audit_failure');
      }
      expect(
        await count('SELECT count(*) FROM memberships WHERE organization_id = $1', [
          organizationId,
        ]),
      ).toBe(1);
      await session(subject).expect(200);
    }
  });
});
