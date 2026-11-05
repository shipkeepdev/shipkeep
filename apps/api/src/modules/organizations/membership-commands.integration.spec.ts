import { Secret } from '@shipkeep/domain';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';
import { AccountMutationAuthority } from '../identity/application/account-mutation-authority';
import { PASSWORD_HASHER, type PasswordHashing } from '../identity/application/identity-ports';
import type { SecurityContext } from '../identity/application/mfa-commands';
import { SessionCommands } from '../identity/application/session-commands';

import { MembershipCommands } from './application/membership-commands';

describe('organization membership commands with restricted PostgreSQL', () => {
  let close: (() => Promise<void>) | undefined;
  let admin: Client;
  let prisma: PrismaService;
  let database: PrismaUnitOfWork;
  let commands: MembershipCommands;
  let accounts: AccountMutationAuthority;
  let sessions: SessionCommands;
  let hash: Secret;
  let actors: SecurityContext[];
  let members: string[];
  let organizationId: string;
  const password = new Secret('membership commands fixture password');
  const client = { ip: '127.0.0.1', userAgent: 'Membership fixture' };

  beforeAll(async () => {
    const fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    prisma = fixture.app.get(PrismaService);
    database = fixture.app.get(PrismaUnitOfWork);
    commands = fixture.app.get(MembershipCommands);
    accounts = fixture.app.get(AccountMutationAuthority);
    sessions = fixture.app.get(SessionCommands);
    hash = await fixture.app.get<PasswordHashing>(PASSWORD_HASHER).hash(password);
  });
  afterAll(async () => {
    await admin.end();
    await close?.();
  });
  beforeEach(async () => {
    actors = Array.from({ length: 5 }, () => ({ userId: uuidv7(), securityVersion: 0, ...client }));
    members = [uuidv7(), uuidv7(), uuidv7()];
    organizationId = uuidv7();
    await prisma.user.createMany({
      data: actors.map(({ userId }) => ({
        id: userId,
        email: `${userId}@example.com`,
        passwordHash: hash.expose(),
        status: 'active',
        emailVerifiedAt: new Date(),
      })),
    });
    await database.runTenant(organizationId, async () => {
      await database.client.organization.create({
        data: {
          id: organizationId,
          name: 'Membership fixture',
          slug: `members-${organizationId.slice(-12)}`,
        },
      });
      await database.client.membership.createMany({
        data: ['owner', 'admin', 'member'].map((orgRole, index) => ({
          id: members[index],
          organizationId,
          userId: actors[index].userId,
          orgRole,
        })),
      });
    });
  });

  it('adds a verified account, audits membership and invalidates its previous session only once', async () => {
    const recipient = actors[3];
    const old = await sessions.login({
      email: `${recipient.userId}@example.com`,
      password,
      ...client,
    });
    const first = await commands.add(
      actors[0],
      organizationId,
      ` ${recipient.userId.toUpperCase()}@EXAMPLE.COM `,
      'admin',
      password,
      {},
    );
    expect(first.value).toMatchObject({
      organizationId,
      userId: recipient.userId,
      orgRole: 'admin',
    });
    await expect(sessions.authenticate(old.token)).rejects.toThrow('Authentication failed.');
    const again = await commands.add(
      actors[0],
      organizationId,
      `${recipient.userId}@example.com`,
      'admin',
      password,
      {},
    );
    expect(again.value.id).toBe(first.value.id);
    expect(await prisma.user.findUnique({ where: { id: recipient.userId } })).toMatchObject({
      securityVersion: 1,
    });
    expect(
      await prisma.auditEvent.count({
        where: { targetId: first.value.id, action: 'membership.added' },
      }),
    ).toBe(1);
    await expect(
      commands.add(
        actors[0],
        organizationId,
        `${recipient.userId}@example.com`,
        'member',
        password,
        {},
      ),
    ).rejects.toMatchObject({ code: 'membership_exists' });
  });

  it('lets administrators manage non-owners and denies owner grants, owner removal and non-administrators', async () => {
    for (const actor of [actors[2], actors[4]])
      await expect(
        commands.add(
          actor,
          organizationId,
          `${actors[3].userId}@example.com`,
          'member',
          password,
          {},
        ),
      ).rejects.toMatchObject({ code: 'resource_not_found' });
    await expect(
      commands.add(
        actors[1],
        organizationId,
        `${actors[3].userId}@example.com`,
        'owner',
        password,
        {},
      ),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
    await expect(
      commands.setRole(actors[1], organizationId, members[0], 'member', password, {}),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
    await expect(
      commands.remove(actors[1], organizationId, members[0], password, {}),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
    expect(
      (await commands.setRole(actors[1], organizationId, members[2], 'admin', password, {})).value
        .orgRole,
    ).toBe('admin');
    expect(
      (
        await commands.add(
          actors[1],
          organizationId,
          `${actors[3].userId}@example.com`,
          'member',
          password,
          {},
        )
      ).value.orgRole,
    ).toBe('member');
  });

  it('protects the final owner and rotates self-demotion after another owner is added', async () => {
    const unchanged = await commands.setRole(
      actors[0],
      organizationId,
      members[0],
      'owner',
      password,
      {},
    );
    expect(unchanged.session).toBeUndefined();
    expect(await prisma.user.findUnique({ where: { id: actors[0].userId } })).toMatchObject({
      securityVersion: 0,
    });
    await expect(
      commands.setRole(actors[0], organizationId, members[0], 'admin', password, {}),
    ).rejects.toMatchObject({ code: 'last_organization_owner' });
    await expect(
      commands.remove(actors[0], organizationId, members[0], password, {}),
    ).rejects.toMatchObject({ code: 'last_organization_owner' });
    const nextOwner = await commands.add(
      actors[0],
      organizationId,
      `${actors[3].userId}@example.com`,
      'owner',
      password,
      {},
    );
    const demoted = await commands.setRole(
      actors[0],
      organizationId,
      members[0],
      'member',
      password,
      {},
    );
    expect(demoted.session).toBeDefined();
    if (!demoted.session) throw new Error('Missing fixture rotation');
    expect((await sessions.authenticate(demoted.session.token)).user.securityVersion).toBe(1);
    await commands.remove(
      { ...actors[3], securityVersion: 1 },
      organizationId,
      members[0],
      password,
      {},
    );
    await expect(
      commands.remove(
        { ...actors[3], securityVersion: 1 },
        organizationId,
        nextOwner.value.id,
        password,
        {},
      ),
    ).rejects.toMatchObject({ code: 'last_organization_owner' });
    expect(
      await database.runTenant(organizationId, () =>
        database.client.membership.count({ where: { orgRole: 'owner' } }),
      ),
    ).toBe(1);
  });

  it('serializes simultaneous owner departures and duplicate additions', async () => {
    await database.runTenant(organizationId, () =>
      database.client.membership.update({ where: { id: members[1] }, data: { orgRole: 'owner' } }),
    );
    const duplicates = await Promise.all(
      [0, 1].map((index) =>
        commands.add(
          actors[index],
          organizationId,
          `${actors[3].userId}@example.com`,
          'member',
          password,
          {},
        ),
      ),
    );
    expect(duplicates[0].value.id).toBe(duplicates[1].value.id);
    expect(await prisma.user.findUnique({ where: { id: actors[3].userId } })).toMatchObject({
      securityVersion: 1,
    });
    const departures = await Promise.allSettled(
      [0, 1].map((index) =>
        commands.remove(actors[index], organizationId, members[index], password, {}),
      ),
    );
    expect(departures.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(departures.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'last_organization_owner' },
    });
    expect(
      await database.runTenant(organizationId, () =>
        database.client.membership.count({ where: { orgRole: 'owner' } }),
      ),
    ).toBe(1);
  });

  it('rejects unknown/foreign members, invalid roles, inactive recipients and stale actors', async () => {
    for (const id of [uuidv7(), 'invalid'])
      await expect(
        commands.setRole(actors[0], organizationId, id, 'admin', password, {}),
      ).rejects.toMatchObject({ code: 'resource_not_found' });
    await expect(
      commands.remove(actors[0], uuidv7(), members[2], password, {}),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
    await expect(
      commands.add(actors[0], organizationId, 'missing@example.com', 'member', password, {}),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
    await expect(
      commands.setRole(actors[0], organizationId, members[2], 'owner\n', password, {}),
    ).rejects.toMatchObject({ code: 'invalid_organization_role' });
    await expect(
      commands.add(
        { ...actors[0], securityVersion: 1 },
        organizationId,
        `${actors[3].userId}@example.com`,
        'member',
        password,
        {},
      ),
    ).rejects.toThrow('Authentication failed.');
    await prisma.user.update({
      where: { id: actors[3].userId },
      data: { status: 'pending', emailVerifiedAt: null },
    });
    await expect(
      commands.add(
        actors[0],
        organizationId,
        `${actors[3].userId}@example.com`,
        'member',
        password,
        {},
      ),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
    await prisma.user.update({ where: { id: actors[2].userId }, data: { status: 'disabled' } });
    await expect(
      commands.setRole(actors[0], organizationId, members[2], 'admin', password, {}),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
    const projectId = uuidv7();
    await database.runTenant(organizationId, async () => {
      await database.client.project.create({
        data: { id: projectId, organizationId, name: 'Removal fixture', slug: 'removal' },
      });
      await database.client.roleBinding.create({
        data: { id: uuidv7(), organizationId, membershipId: members[2], projectId, role: 'admin' },
      });
    });
    await commands.remove(actors[0], organizationId, members[2], password, {});
    expect(
      await database.runTenant(organizationId, () => database.client.roleBinding.count()),
    ).toBe(0);
  });

  it('rolls back each membership command when its audit cannot be appended', async () => {
    await admin.query(
      "ALTER TABLE audit_events ADD CONSTRAINT reject_membership_audit CHECK (action NOT IN ('membership.added','membership.role_changed','membership.removed')) NOT VALID",
    );
    try {
      for (const operation of [
        () =>
          commands.add(
            actors[0],
            organizationId,
            `${actors[3].userId}@example.com`,
            'member',
            password,
            {},
          ),
        () => commands.setRole(actors[0], organizationId, members[2], 'admin', password, {}),
        () => commands.remove(actors[0], organizationId, members[2], password, {}),
      ])
        await expect(operation()).rejects.toThrow();
    } finally {
      await admin.query('ALTER TABLE audit_events DROP CONSTRAINT reject_membership_audit');
    }
    await database.runTenant(organizationId, async () => {
      expect(await database.client.membership.count()).toBe(3);
      expect(
        await database.client.membership.findUnique({ where: { id: members[2] } }),
      ).toMatchObject({ orgRole: 'member' });
    });
    for (const actor of actors)
      expect(await prisma.user.findUnique({ where: { id: actor.userId } })).toMatchObject({
        securityVersion: 0,
      });
  });

  it('rechecks a directory candidate after a concurrent email change', async () => {
    const lookup = accounts.findVerifiedAccount.bind(accounts);
    const spy = vi.spyOn(accounts, 'findVerifiedAccount').mockImplementationOnce(async (email) => {
      const candidate = await lookup(email);
      await prisma.user.update({
        where: { id: actors[3].userId },
        data: { email: `changed-${actors[3].userId}@example.com` },
      });
      return candidate;
    });
    try {
      await expect(
        commands.add(
          actors[0],
          organizationId,
          `${actors[3].userId}@example.com`,
          'member',
          password,
          {},
        ),
      ).rejects.toMatchObject({ code: 'resource_not_found' });
    } finally {
      spy.mockRestore();
    }
    expect(await database.runTenant(organizationId, () => database.client.membership.count())).toBe(
      3,
    );
  });
});
