import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';
import type { SecurityContext } from '../identity/application/mfa-commands';

import { AdministrationQueries } from './application/administration-queries';

describe('membership administration queries with restricted PostgreSQL', () => {
  let close: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  let database: PrismaUnitOfWork;
  let queries: AdministrationQueries;
  const actors: SecurityContext[] = Array.from({ length: 104 }, () => ({
    userId: uuidv7(),
    securityVersion: 0,
    ip: '127.0.0.1',
    userAgent: 'Administration fixture',
  }));
  const members = actors.map(() => uuidv7());
  const orgs = [uuidv7(), uuidv7()];
  const projects = [uuidv7(), uuidv7(), uuidv7()];
  const envs = [uuidv7(), uuidv7()];
  const project = { organizationId: orgs[0], projectId: projects[0] };
  const environment = { ...project, environmentId: envs[0] };

  beforeAll(async () => {
    const fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
    database = fixture.app.get(PrismaUnitOfWork);
    queries = fixture.app.get(AdministrationQueries);
    await prisma.user.createMany({
      data: actors.map(({ userId }, index) => ({
        id: userId,
        email: `${userId}@example.com`,
        passwordHash: 'fixture-hash',
        status: index === 7 ? 'disabled' : 'active',
        emailVerifiedAt: new Date(),
      })),
    });
    await database.runTenant(orgs[0], async () => {
      await database.client.organization.create({
        data: { id: orgs[0], name: 'Administration fixture', slug: 'administration' },
      });
      await database.client.membership.createMany({
        data: members.map((id, index) => ({
          id,
          organizationId: orgs[0],
          userId: actors[index].userId,
          orgRole: index === 0 ? 'owner' : index === 1 ? 'admin' : 'member',
        })),
      });
      await database.client.project.createMany({
        data: projects.slice(0, 2).map((id, index) => ({
          id,
          organizationId: orgs[0],
          name: 'Product',
          slug: `product-${String(index)}`,
        })),
      });
      await database.client.environment.createMany({
        data: envs.map((id, index) => ({
          id,
          organizationId: orgs[0],
          projectId: projects[0],
          name: `env-${String(index)}`,
        })),
      });
      await database.client.roleBinding.createMany({
        data: [
          { id: uuidv7(), ...project, membershipId: members[2], role: 'admin' },
          { id: uuidv7(), ...environment, membershipId: members[3], role: 'admin' },
          { id: uuidv7(), ...project, membershipId: members[4], role: 'developer' },
          { id: uuidv7(), ...environment, membershipId: members[4], role: 'viewer' },
          { id: uuidv7(), ...environment, membershipId: members[5], role: 'viewer' },
          { id: uuidv7(), ...project, membershipId: members[7], role: 'viewer' },
          {
            id: uuidv7(),
            organizationId: orgs[0],
            projectId: projects[1],
            membershipId: members[8],
            role: 'admin',
          },
        ],
      });
    });
    await database.runTenant(orgs[1], async () => {
      await database.client.organization.create({
        data: { id: orgs[1], name: 'Foreign fixture', slug: 'foreign-administration' },
      });
      await database.client.membership.create({
        data: { id: uuidv7(), organizationId: orgs[1], userId: actors[6].userId, orgRole: 'owner' },
      });
      await database.client.project.create({
        data: {
          id: projects[2],
          organizationId: orgs[1],
          name: 'Foreign product',
          slug: 'foreign-product',
        },
      });
    });
  });
  afterAll(async () => {
    await close?.();
  });

  it('bounds the organization directory and returns only administration metadata', async () => {
    const first = await queries.members(actors[0], orgs[0]);
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBe(members[4]);
    const last = await queries.members(actors[1], orgs[0], { cursor: members[4] });
    expect(last.items.map((item) => item.id)).toEqual(members.slice(0, 4).reverse());
    expect(last.nextCursor).toBeNull();
    expect(Object.keys(first.items[0]).sort()).toEqual([
      'active',
      'createdAt',
      'email',
      'id',
      'orgRole',
      'organizationId',
      'updatedAt',
      'userId',
    ]);
    expect(first.items.find((item) => item.id === members[7])).toMatchObject({ active: false });
    expect(await queries.members(actors[0], orgs[0], { cursor: members[0] })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('reports organization, inherited project and explicit environment authority without sibling grants', async () => {
    const rows = (await queries.bindings(actors[3], environment)).items;
    expect(rows.map((row) => row.id)).toEqual([7, 5, 4, 3, 2, 1, 0].map((index) => members[index]));
    expect(rows.find((row) => row.id === members[0])).toMatchObject({
      role: 'admin',
      source: 'organization',
      directRole: null,
      inheritedRole: null,
    });
    expect(rows.find((row) => row.id === members[2])).toMatchObject({
      role: 'admin',
      source: 'project',
      inheritedRole: 'admin',
      directRole: null,
    });
    expect(rows.find((row) => row.id === members[3])).toMatchObject({
      role: 'admin',
      source: 'environment',
      directRole: 'admin',
      inheritedRole: null,
    });
    expect(rows.find((row) => row.id === members[4])).toMatchObject({
      role: 'viewer',
      source: 'environment',
      directRole: 'viewer',
      inheritedRole: 'developer',
    });
    expect(rows.find((row) => row.id === members[7])).toMatchObject({
      active: false,
      role: 'viewer',
    });
    const parent = (await queries.bindings(actors[2], project)).items;
    expect(parent.map((row) => row.id)).toEqual([7, 4, 2, 1, 0].map((index) => members[index]));
    expect(parent.find((row) => row.id === members[4])).toMatchObject({
      role: 'developer',
      source: 'project',
      directRole: 'developer',
      inheritedRole: null,
    });
  });

  it('filters resource grants before pagination and treats cursors only as exclusive bounds', async () => {
    const first = await queries.bindings(actors[2], project, { limit: 1 });
    expect(first.items.map((row) => row.id)).toEqual([members[7]]);
    expect(first.nextCursor).toBe(members[7]);
    const second = await queries.bindings(actors[2], project, { limit: 1, cursor: members[7] });
    expect(second.items.map((row) => row.id)).toEqual([members[4]]);
    expect(
      (await queries.bindings(actors[2], project, { cursor: uuidv7() })).items.every(
        (row) => row.organizationId === orgs[0],
      ),
    ).toBe(true);
    expect(await queries.bindings(actors[2], project, { cursor: members[0] })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('requires administration of the exact scope and rejects stale/invalid query inputs', async () => {
    for (const actor of actors.slice(2, 6))
      await expect(queries.members(actor, orgs[0])).rejects.toMatchObject({
        code: 'resource_not_found',
      });
    for (const operation of [
      () => queries.bindings(actors[3], project),
      () => queries.bindings(actors[3], { ...environment, environmentId: envs[1] }),
      () => queries.bindings(actors[2], { ...project, projectId: projects[1] }),
      () => queries.bindings(actors[4], environment),
      () => queries.bindings(actors[0], { ...environment, organizationId: orgs[1] }),
      () => queries.bindings(actors[0], { ...project, projectId: 'invalid' }),
      () => queries.members(actors[0], orgs[1]),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'resource_not_found' });
    await expect(queries.members(actors[0], orgs[0], { limit: 101 })).rejects.toMatchObject({
      code: 'invalid_catalog_page',
    });
    await expect(queries.bindings(actors[0], project, { cursor: 'invalid' })).rejects.toMatchObject(
      { code: 'invalid_catalog_page' },
    );
    await expect(queries.members({ ...actors[0], securityVersion: 1 }, orgs[0])).rejects.toThrow(
      'Authentication failed.',
    );
    await expect(queries.bindings(actors[7], project)).rejects.toThrow('Authentication failed.');
  });

  it('reflects removed overrides and organization promotion immediately without leaking transaction context', async () => {
    await database.run(async () => {
      await database.runTenant(orgs[0], () =>
        database.client.roleBinding.deleteMany({
          where: { membershipId: members[4], environmentId: envs[0] },
        }),
      );
      expect(
        (await queries.bindings(actors[0], environment)).items.find((row) => row.id === members[4]),
      ).toMatchObject({
        role: 'developer',
        source: 'project',
        directRole: null,
        inheritedRole: 'developer',
      });
      await database.runTenant(orgs[0], () =>
        database.client.membership.update({
          where: { id: members[4] },
          data: { orgRole: 'admin' },
        }),
      );
      expect(
        (await queries.bindings(actors[0], environment)).items.find((row) => row.id === members[4]),
      ).toMatchObject({ role: 'admin', source: 'organization', inheritedRole: 'developer' });
      expect(await database.client.roleBinding.count()).toBe(0);
    });
    expect(await prisma.membership.count()).toBe(0);
  });
});
