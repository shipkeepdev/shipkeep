import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';
import type { SecurityContext } from '../identity/application/mfa-commands';

import { CatalogQueries } from './application/catalog-queries';

describe('resource catalogs with restricted PostgreSQL', () => {
  let close: (() => Promise<void>) | undefined;
  let database: PrismaUnitOfWork;
  let prisma: PrismaService;
  let queries: CatalogQueries;
  const orgs = [uuidv7(), uuidv7()];
  const projects = Array.from({ length: 101 }, () => uuidv7());
  const envs = Array.from({ length: 4 }, () => uuidv7());
  const members = Array.from({ length: 5 }, () => uuidv7());
  const actors: SecurityContext[] = Array.from({ length: 6 }, () => ({
    userId: uuidv7(),
    securityVersion: 0,
    ip: '127.0.0.1',
    userAgent: 'Catalog fixture',
  }));
  const project = { organizationId: orgs[0], projectId: projects[0] };
  const environment = { ...project, environmentId: envs[0] };

  beforeAll(async () => {
    const fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
    database = fixture.app.get(PrismaUnitOfWork);
    queries = fixture.app.get(CatalogQueries);
    await prisma.user.createMany({
      data: actors.map(({ userId }) => ({
        id: userId,
        email: `${userId}@example.com`,
        passwordHash: 'fixture-hash',
        status: 'active',
        emailVerifiedAt: new Date(),
      })),
    });
    for (const [index, id] of orgs.entries())
      await database.runTenant(id, async () => {
        await database.client.organization.create({
          data: { id, name: 'Catalog fixture', slug: `catalog-${String(index)}` },
        });
        await database.client.membership.create({
          data: {
            id: index === 0 ? members[0] : uuidv7(),
            organizationId: id,
            userId: actors[0].userId,
            orgRole: 'owner',
          },
        });
      });
    await database.runTenant(orgs[0], async () => {
      await database.client.membership.createMany({
        data: members.slice(1).map((id, index) => ({
          id,
          organizationId: orgs[0],
          userId: actors[index + 1].userId,
          orgRole: index === 2 ? 'admin' : 'member',
        })),
      });
      await database.client.project.createMany({
        data: projects.map((id, index) => ({
          id,
          organizationId: orgs[0],
          name: 'Catalog product',
          slug: `project-${String(index)}`,
        })),
      });
      await database.client.environment.createMany({
        data: envs.map((id, index) => ({
          id,
          organizationId: orgs[0],
          projectId: projects[index < 2 ? 0 : 1],
          name: `env-${String(index)}`,
        })),
      });
      await database.client.roleBinding.createMany({
        data: [
          {
            id: uuidv7(),
            organizationId: orgs[0],
            membershipId: members[1],
            projectId: projects[0],
            environmentId: envs[0],
            role: 'viewer',
          },
          {
            id: uuidv7(),
            organizationId: orgs[0],
            membershipId: members[2],
            projectId: projects[1],
            role: 'developer',
          },
          {
            id: uuidv7(),
            organizationId: orgs[0],
            membershipId: members[2],
            projectId: projects[1],
            environmentId: envs[2],
            role: 'viewer',
          },
        ],
      });
    });
  });
  afterAll(async () => {
    await close?.();
  });

  it('discovers only the authenticated account organizations and uses an exclusive cursor', async () => {
    expect((await queries.organizations(actors[0])).items.map((item) => item.id)).toEqual(
      [...orgs].reverse(),
    );
    expect((await queries.organizations(actors[1])).items.map((item) => item.id)).toEqual([
      orgs[0],
    ]);
    expect(await queries.organizations(actors[5])).toEqual({ items: [], nextCursor: null });
    const first = await queries.organizations(actors[0], { limit: 1 });
    expect(first.nextCursor).toBe(orgs[1]);
    const second = await queries.organizations(actors[0], { limit: 1, cursor: orgs[1] });
    expect(second.items.map((item) => item.id)).toEqual([orgs[0]]);
    expect(await queries.organizations(actors[0], { cursor: orgs[0] })).toEqual({
      items: [],
      nextCursor: null,
    });
    // An arbitrary/foreign cursor is a range bound, never an existence lookup.
    expect(
      (await queries.organizations(actors[1], { cursor: orgs[1] })).items.map((item) => item.id),
    ).toEqual([orgs[0]]);
    expect(await prisma.organization.count()).toBe(0);
  });

  it('filters grants before pagination and bounds owner/admin catalogs to 100 rows', async () => {
    expect(
      (await queries.projects(actors[1], orgs[0], { limit: 1 })).items.map((item) => item.id),
    ).toEqual([projects[0]]);
    expect((await queries.projects(actors[2], orgs[0])).items.map((item) => item.id)).toEqual([
      projects[1],
    ]);
    expect(await queries.projects(actors[4], orgs[0])).toEqual({ items: [], nextCursor: null });
    for (const actor of [actors[0], actors[3]]) {
      const first = await queries.projects(actor, orgs[0]);
      expect(first.items).toHaveLength(100);
      expect(first.nextCursor).toBe(projects[1]);
      const last = await queries.projects(actor, orgs[0], { cursor: projects[1] });
      expect(last.items.map((item) => item.id)).toEqual([projects[0]]);
      expect(last.nextCursor).toBeNull();
    }
  });

  it('exposes only granted environments while preserving parent navigation and read downgrades', async () => {
    expect((await queries.project(actors[1], project)).id).toBe(projects[0]);
    expect(
      (await queries.environments(actors[1], project, { limit: 1 })).items.map((item) => item.id),
    ).toEqual([envs[0]]);
    expect(await queries.environments(actors[1], project, { cursor: envs[0] })).toEqual({
      items: [],
      nextCursor: null,
    });
    const second = { organizationId: orgs[0], projectId: projects[1] };
    expect((await queries.environments(actors[2], second)).items.map((item) => item.id)).toEqual([
      envs[3],
      envs[2],
    ]);
    expect(
      await queries.environment(actors[2], { ...second, environmentId: envs[2] }),
    ).toMatchObject({ id: envs[2], protected: true });
    expect((await queries.environments(actors[3], project)).items).toHaveLength(2);
  });

  it('rejects missing/foreign details, incorrect ancestry and resource access without membership', async () => {
    expect(await queries.organization(actors[1], orgs[0])).toMatchObject({ id: orgs[0] });
    expect(await queries.environment(actors[1], environment)).toMatchObject({
      id: envs[0],
      kind: 'standard',
    });
    for (const operation of [
      () => queries.organization(actors[1], orgs[1]),
      () => queries.organization(actors[0], uuidv7()),
      () => queries.projects(actors[5], orgs[0]),
      () => queries.project(actors[1], { ...project, projectId: projects[1] }),
      () => queries.environments(actors[4], project),
      () => queries.environment(actors[1], { ...environment, environmentId: envs[1] }),
      () => queries.environment(actors[0], { ...environment, organizationId: orgs[1] }),
      () => queries.environment(actors[0], { ...environment, projectId: projects[1] }),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'resource_not_found' });
  });

  it('rejects malformed bounds, stale security versions and disabled accounts', async () => {
    for (const input of [
      { limit: 0 },
      { limit: -1 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: NaN },
      { cursor: 'invalid' },
      { cursor: `${orgs[0]}\n` },
    ]) {
      for (const operation of [
        () => queries.organizations(actors[0], input),
        () => queries.projects(actors[0], orgs[0], input),
        () => queries.environments(actors[0], project, input),
      ])
        await expect(operation()).rejects.toMatchObject({ code: 'invalid_catalog_page' });
    }
    await expect(queries.organizations({ ...actors[0], securityVersion: 1 })).rejects.toThrow(
      'Authentication failed.',
    );
    await prisma.user.update({ where: { id: actors[5].userId }, data: { status: 'disabled' } });
    await expect(queries.organizations(actors[5])).rejects.toThrow('Authentication failed.');
  });

  it('removes grants immediately, shares the caller transaction and leaves no pooled tenant scope', async () => {
    await database.run(async () => {
      await database.runTenant(orgs[0], () =>
        database.client.roleBinding.deleteMany({ where: { membershipId: members[1] } }),
      );
      expect(await queries.projects(actors[1], orgs[0])).toEqual({ items: [], nextCursor: null });
      await expect(queries.environment(actors[1], environment)).rejects.toMatchObject({
        code: 'resource_not_found',
      });
      expect(await database.client.project.count()).toBe(0);
    });
    await database.runTenant(orgs[0], () =>
      database.client.membership.delete({ where: { id: members[1] } }),
    );
    expect(await queries.organizations(actors[1])).toEqual({ items: [], nextCursor: null });
    expect(await prisma.project.count()).toBe(0);
  });
});
