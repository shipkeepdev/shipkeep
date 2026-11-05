import type { Server } from 'node:http';

import { Secret } from '@shipkeep/domain';
import { Client } from 'pg';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';

import { AppConfig } from '../../platform/config/app-config';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { auditLog } from '../../testing/audit-log';
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
interface BindingBody {
  binding: { id: string; membershipId: string; role: string; environmentId: string | null } | null;
  session?: { userId: string };
}

describe('role binding mutations over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  let admin: Client;
  let closeAdmin: (() => Promise<void>) | undefined;
  let hash: Secret;
  let origin: string;
  let owner: Browser;
  let subject: Browser;
  let other: Browser;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  const memberships = new Map<string, string>();
  const password = new Secret('binding HTTP fixture passphrase');
  const proof = { password: password.expose() };
  const http = () => request(fixture.app.getHttpServer() as Server);
  const resetLimits = () => prisma.identityThrottle.deleteMany();
  const post = (browser: Browser, path: string, body: object) =>
    http()
      .post(`/api/v1/organizations/${organizationId}${path}`)
      .set('Origin', origin)
      .set('Cookie', browser.cookie)
      .set('X-Shipkeep-CSRF', browser.csrf)
      .send(body);
  const get = (browser: Browser, path: string) =>
    http().get(`/api/v1/organizations/${organizationId}${path}`).set('Cookie', browser.cookie);
  const projectPath = () => `/projects/${projectId}`;
  const environmentPath = () => `${projectPath()}/environments/${environmentId}`;

  function cookies(response: request.Response): { cookie: string; csrf: string } {
    const values = response.headers['set-cookie'] as unknown;
    if (!Array.isArray(values) || values.some((value: unknown) => typeof value !== 'string'))
      throw new Error('Missing fixture cookies.');
    const policy = cookiePolicy(origin);
    const pairs = (values as string[]).map((value) => value.split(';')[0]);
    const session = pairs.find((value) => value.startsWith(`${policy.name}=`));
    const csrf = pairs.find((value) => value.startsWith(`${policy.csrfName}=`));
    if (!session || !csrf) throw new Error('Incomplete fixture cookies.');
    return { cookie: session, csrf: csrf.slice(policy.csrfName.length + 1) };
  }
  async function login(browser: Browser): Promise<void> {
    const grant = await fixture.app.get(SessionCommands).login({
      email: browser.email,
      password,
      ip: browser.context.ip,
      userAgent: browser.context.userAgent,
    });
    browser.cookie = `${cookiePolicy(origin).name}=${grant.token.expose()}`;
    browser.csrf = grant.csrf.expose();
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
    const browser = {
      context: { userId, securityVersion: 0, ip: '127.0.0.1', userAgent: label },
      email,
      cookie: '',
      csrf: '',
    };
    await login(browser);
    return browser;
  }
  async function addMember(browser: Browser): Promise<void> {
    await resetLimits();
    const added = await post(owner, '/members', {
      email: browser.email,
      role: 'member',
      ...proof,
    }).expect(201);
    const body = added.body as { membership: { id: string } };
    memberships.set(browser.context.userId, body.membership.id);
    // Joining an organization ends the account's sessions.
    await login(browser);
  }
  /** Resets the password-attempt limit, then assigns `role` to `email` and checks the status. */
  async function assign(
    actor: Browser,
    path: string,
    email: string,
    role: string,
    status: number,
  ): Promise<request.Response> {
    await resetLimits();
    return post(actor, `${path}/bindings`, { email, role, ...proof }).expect(status);
  }
  // Tenant tables are under row-level security: the restricted Prisma client sees no rows
  // outside a tenant transaction, so assertions read them through the administrative login.
  const count = async (sql: string, values: readonly unknown[]): Promise<number> =>
    Number((await admin.query<{ count: string }>(sql, [...values])).rows[0]?.count ?? -1);
  const membershipOf = (browser: Browser) => memberships.get(browser.context.userId) ?? '';

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
    owner = await account('Binding owner');
    subject = await account('Binding subject');
    other = await account('Binding other');
    const created = await http()
      .post('/api/v1/organizations')
      .set('Origin', origin)
      .set('Cookie', owner.cookie)
      .set('X-Shipkeep-CSRF', owner.csrf)
      .send({ name: 'Bindings', slug: `bind-${owner.context.userId.slice(-12)}`, ...proof })
      .expect(201);
    Object.assign(owner, cookies(created));
    // Creating an organization rotated the owner's credentials and security version.
    owner.context = { ...owner.context, securityVersion: owner.context.securityVersion + 1 };
    organizationId = (created.body as { organization: { id: string } }).organization.id;
    const project = await post(owner, '/projects', { name: 'App', slug: 'app' }).expect(201);
    projectId = (project.body as { id: string }).id;
    const environment = await post(owner, `${projectPath()}/environments`, {
      name: 'production',
    }).expect(201);
    environmentId = (environment.body as { id: string }).id;
    await addMember(subject);
    await addMember(other);
  });

  it('grants project access, ends the subject sessions and replays only the same request', async () => {
    await get(subject, projectPath()).expect(404);
    await resetLimits();
    const key = uuidv7();
    const body = { email: subject.email, role: 'developer', ...proof };
    const first = await post(owner, `${projectPath()}/bindings`, body)
      .set('Idempotency-Key', key)
      .expect(200)
      .expect('Idempotency-Replayed', 'false');
    const granted = first.body as BindingBody;
    expect(granted.binding).toMatchObject({
      membershipId: membershipOf(subject),
      role: 'developer',
      environmentId: null,
    });
    expect(granted.session === undefined).toBe(true);
    expect(JSON.stringify(first.body).includes(password.expose())).toBe(false);
    await get(subject, projectPath()).expect(401);
    await login(subject);
    await get(subject, projectPath()).expect(200);
    await get(subject, environmentPath()).expect(200);

    await resetLimits();
    const replay = await post(owner, `${projectPath()}/bindings`, body)
      .set('Idempotency-Key', key)
      .expect(200)
      .expect('Idempotency-Replayed', 'true');
    expect(replay.body).toEqual(first.body);
    await resetLimits();
    await post(owner, `${projectPath()}/bindings`, { ...body, role: 'viewer' })
      .set('Idempotency-Key', key)
      .expect(409);
    const id = granted.binding?.id ?? '';
    expect(
      await auditLog().count({ where: { action: 'role_binding.assigned', targetId: id } }),
    ).toBe(1);
  });

  it('requires a browser session, origin, CSRF and the password, and rejects bearer tokens', async () => {
    const path = `/api/v1/organizations/${organizationId}${projectPath()}/bindings`;
    const body = { email: subject.email, role: 'viewer', ...proof };
    await http().post(path).set('Origin', origin).send(body).expect(401);
    await http().post(path).set('Cookie', owner.cookie).send(body).expect(403);
    await http()
      .post(path)
      .set('Cookie', owner.cookie)
      .set('Origin', origin)
      .send(body)
      .expect(401);
    await post(owner, `${projectPath()}/bindings`, {
      ...body,
      password: 'incorrect fixture passphrase',
    }).expect(401);
    await resetLimits();
    const grant = await fixture.app.get(ApiTokenCommands).create(
      owner.context,
      {
        name: 'Bindings',
        scopes: [{ permission: 'member.manage', organizationId, projectId }],
        expiresAt: new Date(Date.now() + 3600000),
      },
      password,
      {},
    );
    await http()
      .post(path)
      .set('Authorization', `Bearer ${grant.token.expose()}`)
      .send(body)
      .expect(401);
    for (const input of [
      { ...body, role: 'owner' },
      { ...body, email: 'not-an-address' },
      { ...body, projectId: uuidv7() },
      { email: subject.email, role: 'viewer' },
    ])
      await post(owner, `${projectPath()}/bindings`, input).expect(400);
    await post(owner, `${projectPath()}/bindings/invalid/remove`, proof).expect(400);
    await post(owner, `/projects/${uuidv7()}/bindings`, body).expect(404);
    expect(
      await count('SELECT count(*) FROM role_bindings WHERE organization_id = $1', [
        organizationId,
      ]),
    ).toBe(0);
  });

  it('answers unknown addresses and organization administrators like hidden resources', async () => {
    for (const email of [`${uuidv7()}@example.com`, owner.email])
      await assign(owner, projectPath(), email, 'viewer', 404);
    expect(
      await count('SELECT count(*) FROM role_bindings WHERE organization_id = $1', [
        organizationId,
      ]),
    ).toBe(0);
  });

  it('keeps an environment-only administrator from overriding a project administrator', async () => {
    await assign(owner, projectPath(), subject.email, 'admin', 200);
    await assign(owner, environmentPath(), other.email, 'admin', 200);
    await login(other);
    await assign(other, environmentPath(), subject.email, 'viewer', 404);
    await resetLimits();
    await post(
      other,
      `${environmentPath()}/bindings/${membershipOf(subject)}/remove`,
      proof,
    ).expect(404);
    expect(
      await count(
        'SELECT count(*) FROM role_bindings WHERE organization_id = $1 AND environment_id = $2',
        [organizationId, environmentId],
      ),
    ).toBe(1);

    // The project administrator can narrow the environment-only administrator.
    await login(subject);
    const narrowed = await assign(subject, environmentPath(), other.email, 'viewer', 200);
    expect((narrowed.body as BindingBody).binding).toMatchObject({
      environmentId,
      role: 'viewer',
    });
  });

  it('removes a binding, revokes access and replays the removal', async () => {
    await assign(owner, environmentPath(), subject.email, 'developer', 200);
    await login(subject);
    await get(subject, environmentPath()).expect(200);
    await resetLimits();
    const key = uuidv7();
    const removal = () =>
      post(owner, `${environmentPath()}/bindings/${membershipOf(subject)}/remove`, proof).set(
        'Idempotency-Key',
        key,
      );
    expect((await removal().expect(200).expect('Idempotency-Replayed', 'false')).body).toEqual({
      binding: null,
    });
    await resetLimits();
    await removal().expect(200).expect('Idempotency-Replayed', 'true');
    expect(
      await auditLog().count({ where: { organizationId, action: 'role_binding.removed' } }),
    ).toBe(1);
    await login(subject);
    await get(subject, environmentPath()).expect(404);
  });

  it('rolls back the binding and keeps sessions when the audit or retry write fails', async () => {
    for (const constraint of ['retry', 'audit'] as const) {
      if (constraint === 'retry')
        await admin.query(
          'ALTER TABLE identity_replays ADD CONSTRAINT binding_retry_failure CHECK (false) NOT VALID',
        );
      else
        await admin.query(
          "ALTER TABLE audit_events ADD CONSTRAINT binding_audit_failure CHECK (action <> 'role_binding.assigned') NOT VALID",
        );
      try {
        await resetLimits();
        await post(owner, `${projectPath()}/bindings`, {
          email: subject.email,
          role: 'viewer',
          ...proof,
        })
          .set('Idempotency-Key', uuidv7())
          .expect(503);
      } finally {
        if (constraint === 'retry')
          await admin.query('ALTER TABLE identity_replays DROP CONSTRAINT binding_retry_failure');
        else await admin.query('ALTER TABLE audit_events DROP CONSTRAINT binding_audit_failure');
      }
      expect(
        await count('SELECT count(*) FROM role_bindings WHERE organization_id = $1', [
          organizationId,
        ]),
      ).toBe(0);
      await http().get('/api/v1/auth/session').set('Cookie', subject.cookie).expect(200);
    }
  });
});
