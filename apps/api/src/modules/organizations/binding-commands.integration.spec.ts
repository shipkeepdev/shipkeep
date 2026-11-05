import { Secret } from '@shipkeep/domain';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';
import { PASSWORD_HASHER, type PasswordHashing } from '../identity/application/identity-ports';
import type { SecurityContext } from '../identity/application/mfa-commands';
import { SessionCommands } from '../identity/application/session-commands';

import { BindingCommands } from './application/binding-commands';
import type { BindingTarget } from './application/binding-store';
import { MEMBERSHIP_STORE, type MembershipStore } from './application/membership-store';
import { TenantAccess } from './application/tenant-access';

describe('resource role commands with restricted PostgreSQL', () => {
  let close: (() => Promise<void>) | undefined;
  let admin: Client;
  let prisma: PrismaService;
  let database: PrismaUnitOfWork;
  let commands: BindingCommands;
  let access: TenantAccess;
  let sessions: SessionCommands;
  let memberStore: MembershipStore;
  let hash: Secret;
  let actors: SecurityContext[];
  let members: string[];
  let orgs: string[];
  let projects: string[];
  let envs: string[];
  let project: BindingTarget;
  let environment: BindingTarget;
  const password = new Secret('resource role fixture password');
  const client = { ip: '127.0.0.1', userAgent: 'Binding fixture' };

  beforeAll(async () => {
    const fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    prisma = fixture.app.get(PrismaService);
    database = fixture.app.get(PrismaUnitOfWork);
    commands = fixture.app.get(BindingCommands);
    access = fixture.app.get(TenantAccess);
    sessions = fixture.app.get(SessionCommands);
    memberStore = fixture.app.get<MembershipStore>(MEMBERSHIP_STORE);
    hash = await fixture.app.get<PasswordHashing>(PASSWORD_HASHER).hash(password);
  });
  afterAll(async () => {
    await admin.end();
    await close?.();
  });
  beforeEach(async () => {
    actors = Array.from({ length: 7 }, () => ({ userId: uuidv7(), securityVersion: 0, ...client }));
    members = Array.from({ length: 6 }, () => uuidv7());
    orgs = [uuidv7(), uuidv7()];
    projects = [uuidv7(), uuidv7(), uuidv7()];
    envs = [uuidv7(), uuidv7(), uuidv7()];
    project = { organizationId: orgs[0], projectId: projects[0] };
    environment = { ...project, environmentId: envs[0] };
    await prisma.user.createMany({
      data: actors.map(({ userId }) => ({
        id: userId,
        email: `${userId}@example.com`,
        passwordHash: hash.expose(),
        status: 'active',
        emailVerifiedAt: new Date(),
      })),
    });
    for (const [index, id] of orgs.entries())
      await database.runTenant(id, async () => {
        await database.client.organization.create({
          data: { id, name: 'Bindings fixture', slug: `bindings-${id.slice(-12)}` },
        });
        await database.client.membership.create({
          data: {
            id: index === 0 ? members[0] : uuidv7(),
            organizationId: id,
            userId: actors[0].userId,
            orgRole: 'owner',
          },
        });
        const indices = index === 0 ? [0, 1] : [2];
        for (const projectIndex of indices)
          await database.client.project.create({
            data: {
              id: projects[projectIndex],
              organizationId: id,
              name: 'Product',
              slug: `product-${String(projectIndex)}`,
            },
          });
        for (const envIndex of indices)
          await database.client.environment.create({
            data: {
              id: envs[envIndex],
              organizationId: id,
              projectId: projects[index === 0 ? 0 : 2],
              name: `env-${String(envIndex)}`,
              protected: false,
            },
          });
      });
    await database.runTenant(orgs[0], async () => {
      await database.client.membership.createMany({
        data: members.slice(1).map((id, index) => ({
          id,
          organizationId: orgs[0],
          userId: actors[index + 1].userId,
          orgRole: index === 0 ? 'admin' : 'member',
        })),
      });
      await database.client.roleBinding.createMany({
        data: [
          {
            id: uuidv7(),
            organizationId: orgs[0],
            projectId: projects[0],
            membershipId: members[2],
            role: 'admin',
          },
          {
            id: uuidv7(),
            organizationId: orgs[0],
            projectId: projects[0],
            environmentId: envs[0],
            membershipId: members[3],
            role: 'admin',
          },
          {
            id: uuidv7(),
            organizationId: orgs[0],
            projectId: projects[0],
            membershipId: members[4],
            role: 'viewer',
          },
        ],
      });
    });
  });

  it('assigns, changes and removes a project role with auditing and version invalidation', async () => {
    const first = await assign(2, project, 'developer');
    expect(first.value).toMatchObject({
      membershipId: members[5],
      role: 'developer',
      environmentId: null,
    });
    expect(await access.allows(actors[5].userId, 'deploy.run', environment)).toBe(true);
    const changed = await assign(2, project, 'viewer');
    expect(changed.value.id).toBe(first.value.id);
    await assign(2, project, 'viewer');
    expect(await version(5)).toBe(2);
    expect(await access.allows(actors[5].userId, 'deploy.run', environment)).toBe(false);
    await remove(2, project);
    await remove(2, project);
    expect(await version(5)).toBe(3);
    expect(await access.allows(actors[5].userId, 'project.read', project)).toBe(false);
    expect(
      await prisma.auditEvent.count({
        where: { targetId: first.value.id, action: { startsWith: 'role_binding.' } },
      }),
    ).toBe(3);
  });

  it('limits environment admins to their scope and honors explicit downgrades of project admins', async () => {
    await assign(3, environment, 'viewer');
    for (const target of [
      project,
      { ...environment, environmentId: envs[1] },
      { ...project, projectId: projects[1] },
    ])
      await expect(assign(3, target, 'admin')).rejects.toMatchObject({
        code: 'resource_not_found',
      });
    await assign(0, environment, 'viewer', 2);
    actors[2] = { ...actors[2], securityVersion: 1 };
    await expect(assign(2, environment, 'admin')).rejects.toMatchObject({
      code: 'resource_not_found',
    });
    await expect(remove(2, environment, 2)).rejects.toMatchObject({ code: 'resource_not_found' });
    await assign(2, project, 'developer');
    await remove(0, environment, 2);
    expect(await access.allows(actors[2].userId, 'member.manage', environment)).toBe(true);
    expect(await version(2)).toBe(2);
  });

  it('rejects outsiders, owner/admin recipients, unknown accounts, invalid roles and forged ancestry', async () => {
    for (const actor of [4, 5, 6]) {
      await expect(assign(actor, project, 'admin')).rejects.toMatchObject({
        code: 'resource_not_found',
      });
      await expect(remove(actor, project)).rejects.toMatchObject({ code: 'resource_not_found' });
    }
    for (const recipient of [0, 1, 6])
      await expect(assign(0, project, 'admin', recipient)).rejects.toMatchObject({
        code: 'resource_not_found',
      });
    for (const target of [
      { ...environment, organizationId: orgs[1] },
      { ...environment, projectId: projects[1] },
      { ...project, projectId: 'invalid' },
    ])
      await expect(assign(0, target, 'viewer')).rejects.toMatchObject({
        code: 'resource_not_found',
      });
    await expect(assign(0, project, 'owner')).rejects.toMatchObject({
      code: 'invalid_resource_role',
    });
    await expect(commands.remove(actors[0], project, uuidv7(), password, {})).rejects.toMatchObject(
      { code: 'resource_not_found' },
    );
    await expect(
      commands.remove(actors[0], project, 'invalid', password, {}),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
    await assign(1, project, 'viewer');
  });

  it('rotates self-demotion and prevents the newly restricted account from undoing it', async () => {
    const result = await assign(2, project, 'viewer', 2);
    if (!result.session) throw new Error('Missing fixture rotation');
    expect((await sessions.authenticate(result.session.token)).user.securityVersion).toBe(1);
    actors[2] = { ...actors[2], securityVersion: 1 };
    await expect(assign(2, project, 'admin', 2)).rejects.toMatchObject({
      code: 'resource_not_found',
    });
    await assign(0, project, 'admin', 2);
    expect(await version(2)).toBe(2);
  });

  it('rolls back new grants, role updates and removals when auditing fails', async () => {
    const original = await assign(0, project, 'developer');
    await admin.query(
      "ALTER TABLE audit_events ADD CONSTRAINT reject_binding_audit CHECK (action NOT IN ('role_binding.assigned','role_binding.removed')) NOT VALID",
    );
    try {
      for (const operation of [
        () => assign(0, environment, 'viewer'),
        () => assign(0, project, 'viewer'),
        () => remove(0, project),
      ])
        await expect(operation()).rejects.toThrow();
    } finally {
      await admin.query('ALTER TABLE audit_events DROP CONSTRAINT reject_binding_audit');
    }
    expect(await version(5)).toBe(1);
    await database.runTenant(orgs[0], async () => {
      expect(
        await database.client.roleBinding.findMany({ where: { membershipId: members[5] } }),
      ).toMatchObject([{ id: original.value.id, role: 'developer' }]);
    });
    expect(
      await prisma.auditEvent.count({
        where: { targetId: original.value.id, action: { startsWith: 'role_binding.' } },
      }),
    ).toBe(1);
  });

  it('serializes duplicate assignments without creating duplicate bindings or invalidations', async () => {
    const results = await Promise.all([assign(0, project, 'viewer'), assign(1, project, 'viewer')]);
    expect(results[0].value.id).toBe(results[1].value.id);
    expect(await version(5)).toBe(1);
    expect(
      await database.runTenant(orgs[0], () =>
        database.client.roleBinding.count({ where: { membershipId: members[5] } }),
      ),
    ).toBe(1);
  });

  it('rechecks directory candidates and allows removal of grants from disabled members', async () => {
    const lookup = memberStore.forEmail.bind(memberStore);
    const spy = vi
      .spyOn(memberStore, 'forEmail')
      .mockImplementationOnce(async (organizationId, email) => {
        const candidate = await lookup(organizationId, email);
        await database.client.user.update({
          where: { id: actors[5].userId },
          data: { email: `changed-${actors[5].userId}@example.com` },
        });
        return candidate;
      });
    try {
      await expect(assign(0, project, 'viewer')).rejects.toMatchObject({
        code: 'resource_not_found',
      });
    } finally {
      spy.mockRestore();
    }
    await prisma.user.update({
      where: { id: actors[5].userId },
      data: { email: `${actors[5].userId}@example.com` },
    });
    await assign(0, project, 'viewer');
    await prisma.user.update({ where: { id: actors[5].userId }, data: { status: 'disabled' } });
    await expect(assign(0, project, 'admin')).rejects.toMatchObject({ code: 'resource_not_found' });
    await remove(0, project);
    expect(await version(5)).toBe(2);
  });

  function assign(actor: number, target: BindingTarget, role: string, recipient = 5) {
    return commands.assign(
      actors[actor],
      target,
      ` ${actors[recipient].userId.toUpperCase()}@EXAMPLE.COM `,
      role,
      password,
      {},
    );
  }
  function remove(actor: number, target: BindingTarget, recipient = 5) {
    return commands.remove(actors[actor], target, members[recipient], password, {});
  }
  async function version(index: number) {
    return (await prisma.user.findUniqueOrThrow({ where: { id: actors[index].userId } }))
      .securityVersion;
  }
});
