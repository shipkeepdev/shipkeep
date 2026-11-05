import type { Server } from 'node:http';

import { Secret } from '@shipkeep/domain';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';

import { AppConfig } from '../../platform/config/app-config';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';
import { ApiTokenCommands } from '../identity/application/api-token-commands';
import { PASSWORD_HASHER, type PasswordHashing } from '../identity/application/identity-ports';
import type { SecurityContext } from '../identity/application/mfa-commands';
import { SessionCommands } from '../identity/application/session-commands';
import { cookiePolicy } from '../identity/interface/session-http';

import { OrganizationCommands } from './application/organization-commands';
import { ResourceCommands } from './application/resource-commands';

describe('tenant catalog HTTP with restricted PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  let owner: SecurityContext;
  let ownerCookie: string;
  let memberCookie: string;
  let organizationId: string;
  let foreignId: string;
  let projectId: string;
  let siblingProjectId: string;
  let environmentId: string;
  let siblingEnvironmentId: string;
  const password = new Secret('catalog HTTP fixture password');
  const http = () => request(fixture.app.getHttpServer() as Server);
  const path = () => `/api/v1/organizations/${organizationId}`;
  const project = () => `${path()}/projects/${projectId}`;
  const environment = () => `${project()}/environments/${environmentId}`;
  const get = (url: string, cookie = ownerCookie) => http().get(url).set('Cookie', cookie);

  beforeAll(async () => {
    fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
    const hash = await fixture.app.get<PasswordHashing>(PASSWORD_HASHER).hash(password);
    const ids = [uuidv7(), uuidv7()];
    await prisma.user.createMany({
      data: ids.map((id) => ({
        id,
        email: `${id}@example.com`,
        passwordHash: hash.expose(),
        status: 'active',
        emailVerifiedAt: new Date(),
      })),
    });
    owner = { userId: ids[0], securityVersion: 0, ip: '127.0.0.1', userAgent: 'Catalog HTTP' };
    const organizations = fixture.app.get(OrganizationCommands);
    organizationId = (
      await organizations.create(owner, { name: 'Catalog', slug: 'catalog' }, password, {})
    ).organization.id;
    owner = { ...owner, securityVersion: 1 };
    foreignId = (
      await organizations.create(owner, { name: 'Foreign', slug: 'foreign' }, password, {})
    ).organization.id;
    owner = { ...owner, securityVersion: 2 };
    const resources = fixture.app.get(ResourceCommands);
    projectId = (
      await resources.createProject(owner, organizationId, { name: 'Visible', slug: 'visible' })
    ).id;
    siblingProjectId = (
      await resources.createProject(owner, organizationId, { name: 'Private', slug: 'private' })
    ).id;
    environmentId = (
      await resources.createEnvironment(owner, { organizationId, projectId }, { name: 'visible' })
    ).id;
    siblingEnvironmentId = (
      await resources.createEnvironment(owner, { organizationId, projectId }, { name: 'private' })
    ).id;
    const database = fixture.app.get(PrismaUnitOfWork);
    await database.runTenant(organizationId, async () => {
      const member = await database.client.membership.create({
        data: { id: uuidv7(), organizationId, userId: ids[1], orgRole: 'member' },
      });
      await database.client.roleBinding.create({
        data: {
          id: uuidv7(),
          organizationId,
          projectId,
          environmentId,
          membershipId: member.id,
          role: 'viewer',
        },
      });
    });
    const policy = cookiePolicy(fixture.app.get(AppConfig).get('API_PUBLIC_URL'));
    [ownerCookie, memberCookie] = await Promise.all(
      ids.map(async (id) => {
        const grant = await fixture.app.get(SessionCommands).login({
          email: `${id}@example.com`,
          password,
          ip: '127.0.0.1',
          userAgent: 'Catalog HTTP',
        });
        return `${policy.name}=${grant.token.expose()}`;
      }),
    );
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    await prisma.identityThrottle.deleteMany();
  });

  it('paginates account organizations and serializes documented resource metadata', async () => {
    const first = await get('/api/v1/organizations?limit=1')
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(first.body).toMatchObject({ items: [{ id: foreignId }], nextCursor: foreignId });
    const next = await get(`/api/v1/organizations?limit=1&cursor=${foreignId}`).expect(200);
    expect(next.body).toMatchObject({ items: [{ id: organizationId }] });
    const detail = await get(path()).expect(200);
    expect(Object.keys(detail.body as object).sort()).toEqual([
      'createdAt',
      'id',
      'name',
      'slug',
      'updatedAt',
    ]);
    expect(detail.body).toMatchObject({
      id: organizationId,
      name: 'Catalog',
      createdAt: expect.stringMatching(/Z$/),
    });
    // Responses are explicit allowlists: a new column must never leak without a DTO change.
    const projectBody = (await get(project()).expect(200)).body as object;
    expect(Object.keys(projectBody).sort()).toEqual([
      'createdAt',
      'gitWriteMode',
      'id',
      'name',
      'organizationId',
      'slug',
      'updatedAt',
    ]);
    expect(projectBody).toMatchObject({ organizationId, gitWriteMode: 'pull_request' });
    const environmentBody = (await get(environment()).expect(200)).body as object;
    expect(Object.keys(environmentBody).sort()).toEqual([
      'createdAt',
      'failoverPolicy',
      'id',
      'kind',
      'name',
      'organizationId',
      'projectId',
      'protected',
      'updatedAt',
    ]);
    expect(environmentBody).toMatchObject({ organizationId, projectId, protected: true });
  });

  it('filters member lists before pagination while preserving parent navigation', async () => {
    expect((await get('/api/v1/organizations', memberCookie).expect(200)).body).toMatchObject({
      items: [{ id: organizationId }],
      nextCursor: null,
    });
    expect((await get(`${path()}/projects?limit=1`, memberCookie).expect(200)).body).toMatchObject({
      items: [{ id: projectId }],
      nextCursor: projectId,
    });
    expect(
      (await get(`${project()}/environments?limit=1`, memberCookie).expect(200)).body,
    ).toMatchObject({ items: [{ id: environmentId }] });
    await get(project(), memberCookie).expect(200);
    await get(environment(), memberCookie).expect(200);
    for (const url of [
      `/api/v1/organizations/${foreignId}`,
      `${path()}/projects/${siblingProjectId}`,
      `${project()}/environments/${siblingEnvironmentId}`,
    ]) {
      const denied = await get(url, memberCookie).expect(404);
      expect(denied.body).toMatchObject({ code: 'resource_not_found' });
    }
  });

  it('rejects missing/mismatched ancestry and ignores query attempts to forge tenant authority', async () => {
    for (const url of [
      `/api/v1/organizations/${foreignId}/projects/${projectId}`,
      `${path()}/projects/${siblingProjectId}/environments/${environmentId}`,
      `${path()}/projects/${uuidv7()}`,
      '/api/v1/organizations/invalid',
    ])
      expect((await get(url).expect(404)).body).toMatchObject({ code: 'resource_not_found' });
    await get(
      `${path()}/projects/${siblingProjectId}?role=owner&organizationId=${organizationId}`,
      memberCookie,
    ).expect(404);
    await get(`${path()}/projects`).query({ organizationId: foreignId }).expect(400);
  });

  it('accepts scoped bearer details, denies collections and consumes each API quota only once', async () => {
    const commands = fixture.app.get(ApiTokenCommands);
    const grant = await commands.create(
      owner,
      {
        name: 'Catalog reader',
        expiresAt: new Date(Date.now() + 3600000),
        scopes: [
          { permission: 'organization.read', organizationId },
          { permission: 'project.read', organizationId, projectId },
          { permission: 'environment.read', organizationId, projectId, environmentId },
        ],
      },
      password,
      {},
    );
    const bearer = (url: string) =>
      http().get(url).set('Authorization', `Bearer ${grant.token.expose()}`);
    await bearer(path()).expect(200).expect('RateLimit-Remaining', '299');
    await bearer(project()).expect(200).expect('RateLimit-Remaining', '298');
    await bearer(environment()).expect(200).expect('RateLimit-Remaining', '297');
    for (const url of ['/api/v1/organizations', `${path()}/projects`, `${project()}/environments`])
      await bearer(url).expect(401);
    await bearer(`${path()}/projects/${siblingProjectId}`).expect(403);
    await get(project()).set('Authorization', 'Bearer invalid').expect(401);
    await commands.revoke(owner, grant.metadata.id, password, {});
    await bearer(project()).expect(401);
  });

  it('requires authentication and rejects malformed pagination without reflecting input', async () => {
    for (const url of [
      '/api/v1/organizations',
      path(),
      `${path()}/projects`,
      project(),
      `${project()}/environments`,
      environment(),
    ])
      await http().get(url).expect(401);
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: 'many' },
      { cursor: `${projectId}\n` },
      { cursor: 'private-invalid-cursor' },
    ]) {
      const result = await get(`${path()}/projects`).query(query).expect(400);
      expect(JSON.stringify(result.body)).not.toContain('private-invalid-cursor');
    }
  });
});
