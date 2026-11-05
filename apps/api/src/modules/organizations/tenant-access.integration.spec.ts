import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

import { TenantAccess } from './application/tenant-access';

describe('live tenant authority against PostgreSQL', () => {
  let close: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  let database: PrismaUnitOfWork;
  let access: TenantAccess;
  const users = [uuidv7(), uuidv7(), uuidv7(), uuidv7()] as const;
  const orgs = [uuidv7(), uuidv7()] as const;
  const projects = [uuidv7(), uuidv7(), uuidv7()] as const;
  const envs = [uuidv7(), uuidv7(), uuidv7()] as const;
  const members = [uuidv7(), uuidv7()] as const;
  const target = { organizationId: orgs[0], projectId: projects[0], environmentId: envs[0] };

  beforeAll(async () => {
    const fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
    database = fixture.app.get(PrismaUnitOfWork);
    access = fixture.app.get(TenantAccess);
    for (const [index, id] of users.entries())
      await prisma.user.create({
        data: {
          id,
          email: `authority-${String(index)}@example.com`,
          passwordHash: 'fixture-hash',
          status: 'active',
          emailVerifiedAt: new Date(),
        },
      });
    for (const [index, id] of orgs.entries())
      await database.runTenant(id, async () => {
        await database.client.organization.create({
          data: { id, name: 'Authority fixture', slug: `authority-${String(index)}` },
        });
        await database.client.membership.create({
          data: { id: uuidv7(), organizationId: id, userId: users[index], orgRole: 'owner' },
        });
        await database.client.project.create({
          data: { id: projects[index], organizationId: id, name: 'Product', slug: 'product' },
        });
        await database.client.environment.create({
          data: {
            id: envs[index],
            organizationId: id,
            projectId: projects[index],
            name: 'preview',
            protected: false,
          },
        });
      });
    await database.runTenant(orgs[0], async () => {
      await database.client.project.create({
        data: { id: projects[2], organizationId: orgs[0], name: 'Sibling', slug: 'sibling' },
      });
      await database.client.environment.create({
        data: { id: envs[2], organizationId: orgs[0], projectId: projects[0], name: 'production' },
      });
      for (const [index, userId] of [users[2], users[3]].entries()) {
        await database.client.membership.create({
          data: { id: members[index], organizationId: orgs[0], userId, orgRole: 'member' },
        });
        await database.client.roleBinding.create({
          data: {
            id: uuidv7(),
            organizationId: orgs[0],
            membershipId: members[index],
            projectId: projects[0],
            environmentId: index === 0 ? null : envs[0],
            role: index === 0 ? 'developer' : 'viewer',
          },
        });
      }
    });
  });
  afterAll(async () => {
    await close?.();
  });

  it('requires live membership and rejects foreign or incorrect resource ancestry even for owners', async () => {
    await access.require(users[0], 'organization.read', { organizationId: orgs[0] });
    expect(await access.allows(users[0], 'organization.read', { organizationId: orgs[0] })).toBe(
      true,
    );
    expect(await access.allows(users[0], 'organization.read', { organizationId: orgs[1] })).toBe(
      false,
    );
    for (const foreign of [
      { ...target, projectId: projects[1] },
      { ...target, projectId: projects[2] },
      { ...target, environmentId: envs[1] },
      { ...target, environmentId: uuidv7() },
    ])
      expect(await access.allows(users[0], 'environment.read', foreign)).toBe(false);
    await expect(
      access.require(users[0], 'project.read', { organizationId: orgs[1], projectId: projects[1] }),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
  });

  it('loads protection from storage and ignores forged protection metadata', async () => {
    expect(await access.allows(users[2], 'deploy.run', target)).toBe(true);
    await database.runTenant(orgs[0], async () => {
      await database.client.environment.update({
        where: { id: envs[0] },
        data: { protected: true },
      });
    });
    try {
      const forged = { ...target, protected: false };
      expect(await access.allows(users[2], 'deploy.run', forged)).toBe(false);
      expect(await access.allows(users[0], 'deploy.run', target)).toBe(true);
    } finally {
      await database.runTenant(orgs[0], async () => {
        await database.client.environment.update({
          where: { id: envs[0] },
          data: { protected: false },
        });
      });
    }
  });

  it('applies explicit environment role downgrades and subsequent role changes immediately', async () => {
    const id = uuidv7();
    await database.runTenant(orgs[0], async () => {
      await database.client.roleBinding.create({
        data: {
          id,
          organizationId: orgs[0],
          membershipId: members[0],
          projectId: projects[0],
          environmentId: envs[0],
          role: 'viewer',
        },
      });
    });
    try {
      expect(await access.allows(users[2], 'deploy.run', target)).toBe(false);
      expect(await access.allows(users[2], 'environment.read', target)).toBe(true);
      await database.runTenant(orgs[0], async () => {
        await database.client.roleBinding.update({ where: { id }, data: { role: 'admin' } });
      });
      expect(await access.allows(users[2], 'member.manage', target)).toBe(true);
    } finally {
      await database.runTenant(orgs[0], async () => {
        await database.client.roleBinding.delete({ where: { id } });
      });
    }
    expect(await access.allows(users[2], 'member.manage', target)).toBe(false);
  });

  it('limits environment-only grants to their environment and parent navigation', async () => {
    expect(
      await access.allows(users[3], 'project.read', {
        organizationId: orgs[0],
        projectId: projects[0],
      }),
    ).toBe(true);
    expect(await access.allows(users[3], 'environment.read', target)).toBe(true);
    expect(
      await access.allows(users[3], 'environment.read', { ...target, environmentId: envs[2] }),
    ).toBe(false);
    expect(await access.allows(users[3], 'project.create', { organizationId: orgs[0] })).toBe(
      false,
    );
    expect(await access.allows(users[3], 'member.manage', target)).toBe(false);
  });

  it('denies disabled users and removed memberships without cached grants', async () => {
    await prisma.user.update({ where: { id: users[3] }, data: { status: 'disabled' } });
    try {
      expect(await access.allows(users[3], 'environment.read', target)).toBe(false);
    } finally {
      await prisma.user.update({ where: { id: users[3] }, data: { status: 'active' } });
    }
    await database.runTenant(orgs[0], async () => {
      await database.client.membership.delete({ where: { id: members[1] } });
    });
    expect(await access.allows(users[3], 'organization.read', { organizationId: orgs[0] })).toBe(
      false,
    );
  });

  it('denies unknown capabilities, malformed ids, incomplete contexts and missing accounts', async () => {
    for (const resource of [
      {},
      { ...target, organizationId: 'invalid' },
      { ...target, projectId: 'invalid' },
      { ...target, environmentId: 'invalid' },
      { organizationId: orgs[0], environmentId: envs[0] },
    ])
      expect(await access.allows(users[0], 'environment.read', resource)).toBe(false);
    expect(await access.allows('invalid', 'organization.read', target)).toBe(false);
    expect(await access.allows(uuidv7(), 'environment.read', target)).toBe(false);
    expect(await access.allows(users[0], 'unknown.manage', target)).toBe(false);
    expect(await access.allows(users[0], 'profile.read', target)).toBe(false);
  });

  it('uses the caller transaction and sees uncommitted resource changes without leaking context', async () => {
    const projectId = uuidv7();
    await expect(
      database.runTenant(orgs[0], async () => {
        await database.client.project.create({
          data: {
            id: projectId,
            organizationId: orgs[0],
            name: 'Rolled back',
            slug: 'rolled-back',
          },
        });
        expect(
          await access.allows(users[0], 'project.read', { organizationId: orgs[0], projectId }),
        ).toBe(true);
        throw new Error('injected rollback');
      }),
    ).rejects.toThrow('Tenant storage temporarily unavailable.');
    expect(
      await access.allows(users[0], 'project.read', { organizationId: orgs[0], projectId }),
    ).toBe(false);
    expect(await prisma.membership.count()).toBe(0);
    expect(await prisma.project.count()).toBe(0);
  });
});
