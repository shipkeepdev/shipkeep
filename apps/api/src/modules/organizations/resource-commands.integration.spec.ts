import { Secret } from '@shipkeep/domain';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { auditLog } from '../../testing/audit-log';
import { integrationApp } from '../../testing/integration-app';
import { PASSWORD_HASHER, type PasswordHashing } from '../identity/application/identity-ports';
import type { SecurityContext } from '../identity/application/mfa-commands';

import { OrganizationCommands } from './application/organization-commands';
import { ResourceCommands } from './application/resource-commands';
import type { EnvironmentTarget } from './application/resource-store';

describe('project and environment commands with restricted PostgreSQL', () => {
  let close: (() => Promise<void>) | undefined;
  let admin: Client;
  let database: PrismaUnitOfWork;
  let prisma: PrismaService;
  let commands: ResourceCommands;
  let actors: SecurityContext[];
  let organizationId: string;
  let foreignOrganizationId: string;
  let target: EnvironmentTarget;
  const memberIds = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
  const names = { name: 'Resource fixture', slug: 'resource-fixture' };

  beforeAll(async () => {
    const fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    database = fixture.app.get(PrismaUnitOfWork);
    prisma = fixture.app.get(PrismaService);
    commands = fixture.app.get(ResourceCommands);
    const password = new Secret('resource commands fixture password');
    const hash = await fixture.app.get<PasswordHashing>(PASSWORD_HASHER).hash(password);
    actors = await Promise.all(
      Array.from({ length: 6 }, async () => {
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
        return { userId, securityVersion: 0, ip: '127.0.0.1', userAgent: 'Resource fixture' };
      }),
    );
    const organizations = fixture.app.get(OrganizationCommands);
    organizationId = (
      await organizations.create(actors[0], { name: 'First', slug: 'first' }, password, {})
    ).organization.id;
    actors[0] = { ...actors[0], securityVersion: 1 };
    foreignOrganizationId = (
      await organizations.create(actors[0], { name: 'Second', slug: 'second' }, password, {})
    ).organization.id;
    actors[0] = { ...actors[0], securityVersion: 2 };
    await database.runTenant(organizationId, () =>
      database.client.membership.createMany({
        data: memberIds.map((id, index) => ({
          id,
          organizationId,
          userId: actors[index + 1].userId,
          orgRole: index === 0 ? 'admin' : 'member',
        })),
      }),
    );
  });
  afterAll(async () => {
    await admin.end();
    await close?.();
  });
  beforeEach(async () => {
    const project = await commands.createProject(actors[0], organizationId, {
      ...names,
      slug: `project-${uuidv7().slice(-12)}`,
    });
    const environment = await commands.createEnvironment(
      actors[0],
      { organizationId, projectId: project.id },
      { name: 'production' },
    );
    target = { organizationId, projectId: project.id, environmentId: environment.id };
    await database.runTenant(organizationId, () =>
      database.client.roleBinding.createMany({
        data: ['admin', 'developer', 'viewer'].map((role, index) => ({
          id: uuidv7(),
          organizationId,
          membershipId: memberIds[index + 1],
          projectId: project.id,
          role,
        })),
      }),
    );
  });

  it('uses safe defaults, whitelists ownership and audits all four commands with settings', async () => {
    const project = await commands.createProject(actors[0], foreignOrganizationId, {
      ...names,
      organizationId,
    } as typeof names);
    expect(project).toMatchObject({
      organizationId: foreignOrganizationId,
      gitWriteMode: 'pull_request',
    });
    const environment = await commands.createEnvironment(
      actors[0],
      { organizationId: foreignOrganizationId, projectId: project.id },
      { name: 'staging' },
    );
    expect(environment).toMatchObject({
      protected: true,
      failoverPolicy: 'none',
      kind: 'standard',
    });
    expect(
      await commands.updateProject(
        actors[2],
        { organizationId, projectId: target.projectId },
        { name: 'Updated project', slug: 'updated', gitWriteMode: 'commit' },
      ),
    ).toMatchObject({ gitWriteMode: 'commit' });
    expect(
      await commands.updateEnvironment(actors[2], target, {
        name: 'preview',
        kind: 'preview',
        protected: false,
        failoverPolicy: 'restore-from-backup',
      }),
    ).toMatchObject({ kind: 'preview', protected: false, failoverPolicy: 'restore-from-backup' });
    for (const [id, action] of [
      [project.id, 'project.created'],
      [environment.id, 'environment.created'],
      [target.projectId, 'project.updated'],
      [target.environmentId, 'environment.updated'],
    ])
      expect(await auditLog().findFirst({ where: { targetId: id, action } })).toMatchObject({
        action,
      });
    expect(await prisma.project.count()).toBe(0);
  });

  it.each([0, 1, 2, 3, 4, 5])('enforces the command role matrix for actor %i', async (index) => {
    const actor = actors[index];
    const projectCreation = commands.createProject(actor, organizationId, {
      ...names,
      slug: `role-${String(index)}`,
    });
    if (index < 2) await expect(projectCreation).resolves.toMatchObject({ organizationId });
    else await expect(projectCreation).rejects.toMatchObject({ code: 'resource_not_found' });
    const operations = [
      () =>
        commands.updateProject(
          actor,
          { organizationId, projectId: target.projectId },
          { ...names, slug: `updated-role-${String(index)}` },
        ),
      () =>
        commands.createEnvironment(
          actor,
          { organizationId, projectId: target.projectId },
          { name: 'staging' },
        ),
      () => commands.updateEnvironment(actor, target, { name: 'production', protected: false }),
    ];
    for (const operation of operations)
      if (index < 3) await expect(operation()).resolves.toBeDefined();
      else await expect(operation()).rejects.toMatchObject({ code: 'resource_not_found' });
  });

  it('rejects wrong ancestry, sibling resources and environment-only administration of a project', async () => {
    const sibling = await commands.createProject(actors[0], organizationId, {
      ...names,
      slug: 'sibling',
    });
    for (const wrong of [
      { ...target, organizationId: foreignOrganizationId },
      { ...target, projectId: sibling.id },
    ])
      await expect(
        commands.updateEnvironment(actors[0], wrong, { name: 'foreign' }),
      ).rejects.toMatchObject({ code: 'resource_not_found' });
    await expect(
      commands.updateProject(actors[2], { organizationId, projectId: sibling.id }, names),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
    await database.runTenant(organizationId, () =>
      database.client.roleBinding.updateMany({
        where: { membershipId: memberIds[1], projectId: target.projectId },
        data: { environmentId: target.environmentId },
      }),
    );
    await commands.updateEnvironment(actors[2], target, { name: 'allowed' });
    await expect(
      commands.updateProject(actors[2], { organizationId, projectId: target.projectId }, names),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
    await expect(
      commands.createEnvironment(
        actors[2],
        { organizationId, projectId: target.projectId },
        { name: 'denied' },
      ),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
  });

  it('resolves concurrent duplicate names and rolls back rename collisions', async () => {
    const projectTarget = { organizationId, projectId: target.projectId };
    for (const [kind, operation] of [
      [
        'project',
        (actor: SecurityContext) =>
          commands.createProject(actor, organizationId, { ...names, slug: 'duplicate' }),
      ],
      [
        'environment',
        (actor: SecurityContext) =>
          commands.createEnvironment(actor, projectTarget, { name: 'duplicate' }),
      ],
    ] as const) {
      const results = await Promise.allSettled([operation(actors[0]), operation(actors[1])]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        reason: { code: `${kind}_name_unavailable` },
      });
    }
    await expect(
      commands.updateProject(actors[0], projectTarget, { ...names, slug: 'duplicate' }),
    ).rejects.toMatchObject({ code: 'project_name_unavailable' });
    await expect(
      commands.updateEnvironment(actors[0], target, { name: 'duplicate' }),
    ).rejects.toMatchObject({ code: 'environment_name_unavailable' });
    await database.runTenant(organizationId, async () => {
      expect(
        await database.client.project.findUnique({ where: { id: target.projectId } }),
      ).not.toMatchObject({ slug: 'duplicate' });
      expect(
        await database.client.environment.findUnique({ where: { id: target.environmentId } }),
      ).toMatchObject({ name: 'production' });
    });
  });

  it('rolls back each write when its audit fails and rejects invalid settings before writing', async () => {
    const projectTarget = { organizationId, projectId: target.projectId };
    await expect(
      commands.createProject(actors[0], organizationId, { ...names, gitWriteMode: 'execute' }),
    ).rejects.toMatchObject({ code: 'invalid_git_write_mode' });
    await expect(
      commands.updateEnvironment(actors[0], target, { name: 'bad\n' }),
    ).rejects.toMatchObject({ code: 'invalid_resource_slug' });
    await admin.query(
      "ALTER TABLE audit_events ADD CONSTRAINT reject_resource_audit CHECK (action NOT IN ('project.created','project.updated','environment.created','environment.updated')) NOT VALID",
    );
    try {
      for (const operation of [
        () => commands.createProject(actors[0], organizationId, { ...names, slug: 'rollback' }),
        () => commands.createEnvironment(actors[0], projectTarget, { name: 'rollback' }),
        () => commands.updateProject(actors[0], projectTarget, { ...names, slug: 'rollback' }),
        () => commands.updateEnvironment(actors[0], target, { name: 'rollback' }),
      ])
        await expect(operation()).rejects.toThrow();
    } finally {
      await admin.query('ALTER TABLE audit_events DROP CONSTRAINT reject_resource_audit');
    }
    await database.runTenant(organizationId, async () => {
      expect(await database.client.project.count({ where: { slug: 'rollback' } })).toBe(0);
      expect(await database.client.environment.count({ where: { name: 'rollback' } })).toBe(0);
    });
    expect(
      await auditLog().count({
        where: { metadata: { path: ['slug'], equals: 'rollback' } },
      }),
    ).toBe(0);
  });
});
