import type { Server } from 'node:http';

import { Secret } from '@shipkeep/domain';
import { Client } from 'pg';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';

import { AppConfig } from '../../platform/config/app-config';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { auditLog } from '../../testing/audit-log';
import { integrationApp } from '../../testing/integration-app';
import { ApiTokenCommands } from '../identity/application/api-token-commands';
import { PASSWORD_HASHER, type PasswordHashing } from '../identity/application/identity-ports';
import type { SecurityContext } from '../identity/application/mfa-commands';
import { SessionCommands } from '../identity/application/session-commands';
import { cookiePolicy } from '../identity/interface/session-http';

import { OrganizationCommands } from './application/organization-commands';
import { ResourceCommands } from './application/resource-commands';

describe('project and environment mutations over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let closeAdmin: (() => Promise<void>) | undefined;
  let admin: Client;
  let prisma: PrismaService;
  let database: PrismaUnitOfWork;
  let owner: SecurityContext;
  let browsers: { cookie: string; csrf: string }[];
  let organizationId: string;
  let foreignId: string;
  let target: { organizationId: string; projectId: string; environmentId: string };
  let origin: string;
  const members = [uuidv7(), uuidv7(), uuidv7()];
  const password = new Secret('resource HTTP fixture password');
  const http = () => request(fixture.app.getHttpServer() as Server);
  const root = () => `/api/v1/organizations/${organizationId}`;
  const project = () => `${root()}/projects/${target.projectId}`;
  const environment = () => `${project()}/environments/${target.environmentId}`;
  const projectBody = () => ({ name: 'HTTP project', slug: `http-${target.projectId.slice(-12)}` });
  const post = (url: string, body: object, actor = 0) =>
    http()
      .post(url)
      .set('Origin', origin)
      .set('Cookie', browsers[actor].cookie)
      .set('X-Shipkeep-CSRF', browsers[actor].csrf)
      .send(body);

  beforeAll(async () => {
    fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    closeAdmin = () => admin.end();
    prisma = fixture.app.get(PrismaService);
    database = fixture.app.get(PrismaUnitOfWork);
    origin = new URL(fixture.app.get(AppConfig).get('API_PUBLIC_URL')).origin;
    const hash = await fixture.app.get<PasswordHashing>(PASSWORD_HASHER).hash(password);
    const ids = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    await prisma.user.createMany({
      data: ids.map((id) => ({
        id,
        email: `${id}@example.com`,
        passwordHash: hash.expose(),
        status: 'active',
        emailVerifiedAt: new Date(),
      })),
    });
    owner = { userId: ids[0], securityVersion: 0, ip: '127.0.0.1', userAgent: 'Resource HTTP' };
    const organizations = fixture.app.get(OrganizationCommands);
    organizationId = (
      await organizations.create(
        owner,
        { name: 'HTTP resources', slug: 'http-resources' },
        password,
        {},
      )
    ).organization.id;
    owner = { ...owner, securityVersion: 1 };
    foreignId = (
      await organizations.create(owner, { name: 'Foreign', slug: 'foreign' }, password, {})
    ).organization.id;
    owner = { ...owner, securityVersion: 2 };
    await database.runTenant(organizationId, () =>
      database.client.membership.createMany({
        data: members.map((id, index) => ({
          id,
          organizationId,
          userId: ids[index + 1],
          orgRole: 'member',
        })),
      }),
    );
    browsers = await Promise.all(
      ids.map(async (id) => {
        const session = await fixture.app.get(SessionCommands).login({
          email: `${id}@example.com`,
          password,
          ip: owner.ip,
          userAgent: owner.userAgent,
        });
        return {
          cookie: `${cookiePolicy(origin).name}=${session.token.expose()}`,
          csrf: session.csrf.expose(),
        };
      }),
    );
  });
  afterAll(async () => {
    await closeAdmin?.();
    await close?.();
  });
  beforeEach(async () => {
    await prisma.identityThrottle.deleteMany();
    const resources = fixture.app.get(ResourceCommands);
    const created = await resources.createProject(owner, organizationId, {
      name: 'Initial',
      slug: `initial-${uuidv7().slice(-12)}`,
    });
    const environment = await resources.createEnvironment(
      owner,
      { organizationId, projectId: created.id },
      { name: 'initial' },
    );
    target = { organizationId, projectId: created.id, environmentId: environment.id };
    await database.runTenant(organizationId, () =>
      database.client.roleBinding.createMany({
        data: members.map((id, index) => ({
          id: uuidv7(),
          organizationId,
          membershipId: id,
          projectId: target.projectId,
          environmentId: index === 1 ? target.environmentId : null,
          role: index === 2 ? 'viewer' : 'admin',
        })),
      }),
    );
  });

  it('creates and updates resources with safe defaults, ISO metadata and audited retries', async () => {
    const key = uuidv7();
    const body = projectBody();
    const created = await post(`${root()}/projects`, body).set('Idempotency-Key', key).expect(201);
    const id = (created.body as { id: string }).id;
    expect(created.body).toMatchObject({
      organizationId,
      gitWriteMode: 'pull_request',
      createdAt: expect.stringMatching(/Z$/),
    });
    const retry = await post(`${root()}/projects`, body)
      .set('Idempotency-Key', key)
      .expect(201)
      .expect('Idempotency-Replayed', 'true');
    expect(retry.body).toEqual(created.body);
    expect(await auditLog().count({ where: { action: 'project.created', targetId: id } })).toBe(1);
    const createdEnvironment = await post(`${root()}/projects/${id}/environments`, {
      name: 'production',
    }).expect(201);
    expect(createdEnvironment.body).toMatchObject({
      organizationId,
      projectId: id,
      protected: true,
      kind: 'standard',
      failoverPolicy: 'none',
    });
    await post(`${project()}/settings`, {
      ...body,
      slug: `updated-${id.slice(-12)}`,
      gitWriteMode: 'commit',
    }).expect(200);
    const update = await post(`${environment()}/settings`, {
      name: 'preview',
      kind: 'preview',
      failoverPolicy: 'restore-from-backup',
      protected: false,
    }).expect(200);
    expect(update.body).toMatchObject({
      protected: false,
      kind: 'preview',
      failoverPolicy: 'restore-from-backup',
    });
    expect(
      await auditLog().count({
        where: { action: 'environment.updated', targetId: target.environmentId, actorKind: 'user' },
      }),
    ).toBe(1);
  });

  it('enforces project-admin, environment-admin and viewer authority at each route', async () => {
    for (const actor of [1, 2, 3]) {
      await post(`${root()}/projects`, projectBody(), actor).expect(404);
      await post(`${project()}/settings`, projectBody(), actor).expect(actor === 1 ? 200 : 404);
      await post(`${project()}/environments`, { name: 'new-environment' }, actor).expect(
        actor === 1 ? 201 : 404,
      );
      await post(`${environment()}/settings`, { name: 'updated' }, actor).expect(
        actor < 3 ? 200 : 404,
      );
    }
  });

  it('supports scoped bearer writes without CSRF and prevents sibling scope escalation', async () => {
    const commands = fixture.app.get(ApiTokenCommands);
    const projectTarget = { organizationId, projectId: target.projectId };
    const grant = await commands.create(
      owner,
      {
        name: 'Resource writes',
        expiresAt: new Date(Date.now() + 3600000),
        scopes: [
          { permission: 'project.create', organizationId },
          { permission: 'project.update', ...projectTarget },
          { permission: 'environment.create', ...projectTarget },
          { permission: 'environment.update', ...target },
        ],
      },
      password,
      {},
    );
    const bearer = (url: string, body: object) =>
      http().post(url).set('Authorization', `Bearer ${grant.token.expose()}`).send(body);
    const created = await bearer(`${root()}/projects`, projectBody()).expect(201);
    const sibling = (created.body as { id: string }).id;
    await bearer(`${project()}/settings`, {
      ...projectBody(),
      slug: `token-${target.projectId.slice(-12)}`,
    }).expect(200);
    await bearer(`${project()}/environments`, { name: 'token-created' }).expect(201);
    await bearer(`${environment()}/settings`, { name: 'token-updated' }).expect(200);
    expect(
      await auditLog().count({
        where: { actorKind: 'api_token', actorId: grant.metadata.id },
      }),
    ).toBe(4);
    await bearer(`${root()}/projects/${sibling}/settings`, projectBody()).expect(403);
    await bearer(`${root()}/projects/${sibling}/environments`, { name: 'denied' }).expect(403);
    const read = await commands.create(
      owner,
      {
        name: 'Reader',
        expiresAt: new Date(Date.now() + 3600000),
        scopes: [{ permission: 'project.read', ...projectTarget }],
      },
      password,
      {},
    );
    await http()
      .post(`${project()}/settings`)
      .set('Authorization', `Bearer ${read.token.expose()}`)
      .send(projectBody())
      .expect(403);
  });

  it('rejects malformed settings, ownership injection, wrong ancestry and browser CSRF omissions', async () => {
    await http()
      .post(`${project()}/settings`)
      .set('Cookie', browsers[0].cookie)
      .send(projectBody())
      .expect(403);
    await http()
      .post(`${project()}/settings`)
      .set('Origin', origin)
      .set('Cookie', browsers[0].cookie)
      .send(projectBody())
      .expect(401);
    await http()
      .post(`${project()}/settings`)
      .set('Origin', origin)
      .send(projectBody())
      .expect(401);
    for (const body of [
      { ...projectBody(), organizationId: foreignId },
      { ...projectBody(), gitWriteMode: null },
      { ...projectBody(), gitWriteMode: 'shell' },
      { ...projectBody(), slug: 'bad\n' },
    ])
      await post(`${project()}/settings`, body).expect(400);
    for (const body of [
      { name: 'valid', protected: 'false' },
      { name: 'valid', protected: null },
      { name: 'valid', kind: null },
      { name: 'valid', failoverPolicy: 'automatic' },
      { name: 'valid', projectId: uuidv7() },
    ])
      await post(`${environment()}/settings`, body).expect(400);
    await post(
      `/api/v1/organizations/${foreignId}/projects/${target.projectId}/settings`,
      projectBody(),
    ).expect(404);
    await post(`${project()}/environments/${uuidv7()}/settings`, { name: 'missing' }).expect(404);
    await post(`${root()}/projects/invalid/settings`, projectBody()).expect(404);
  });

  it('rolls back all four HTTP mutations when retry persistence fails', async () => {
    const before = await database.runTenant(organizationId, async () => ({
      projects: await database.client.project.count(),
      environments: await database.client.environment.count(),
      project: await database.client.project.findUnique({ where: { id: target.projectId } }),
      environment: await database.client.environment.findUnique({
        where: { id: target.environmentId },
      }),
    }));
    const audits = await auditLog().count();
    await admin.query(
      'ALTER TABLE identity_replays ADD CONSTRAINT resource_http_retry_failure CHECK (false) NOT VALID',
    );
    try {
      for (const [url, body] of [
        [`${root()}/projects`, projectBody()],
        [`${project()}/settings`, projectBody()],
        [`${project()}/environments`, { name: 'rolled-back' }],
        [`${environment()}/settings`, { name: 'rolled-back' }],
      ] as const)
        await post(url, body).set('Idempotency-Key', uuidv7()).expect(503);
    } finally {
      await admin.query('ALTER TABLE identity_replays DROP CONSTRAINT resource_http_retry_failure');
    }
    const after = await database.runTenant(organizationId, async () => ({
      projects: await database.client.project.count(),
      environments: await database.client.environment.count(),
      project: await database.client.project.findUnique({ where: { id: target.projectId } }),
      environment: await database.client.environment.findUnique({
        where: { id: target.environmentId },
      }),
    }));
    expect(after).toEqual(before);
    expect(await auditLog().count()).toBe(audits);
  });
});
