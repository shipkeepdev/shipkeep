import { Secret } from '@shipkeep/domain';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { auditLog } from '../../testing/audit-log';
import { integrationApp } from '../../testing/integration-app';
import { PASSWORD_HASHER, type PasswordHashing } from '../identity/application/identity-ports';
import type { SecurityContext } from '../identity/application/mfa-commands';
import { SessionCommands } from '../identity/application/session-commands';

import { OrganizationCommands } from './application/organization-commands';

describe('audited organization commands with restricted PostgreSQL', () => {
  let close: (() => Promise<void>) | undefined;
  let admin: Client;
  let prisma: PrismaService;
  let database: PrismaUnitOfWork;
  let commands: OrganizationCommands;
  let sessions: SessionCommands;
  let hash: Secret;
  const password = new Secret('organization commands fixture password');
  const client = { ip: '127.0.0.1', userAgent: 'Organization fixture' };

  beforeAll(async () => {
    const fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    prisma = fixture.app.get(PrismaService);
    database = fixture.app.get(PrismaUnitOfWork);
    commands = fixture.app.get(OrganizationCommands);
    sessions = fixture.app.get(SessionCommands);
    hash = await fixture.app.get<PasswordHashing>(PASSWORD_HASHER).hash(password);
  });
  afterAll(async () => {
    await admin.end();
    await close?.();
  });

  it('creates the creator as owner, audits ownership and rotates existing sessions atomically', async () => {
    const actor = await account();
    const old = await sessions.login({ email: `${actor.userId}@example.com`, password, ...client });
    const result = await commands.create(
      actor,
      { name: '  Product team  ', slug: 'product-team' },
      password,
      {},
    );
    expect(result.organization.name).toBe('Product team');
    await database.runTenant(result.organization.id, async () => {
      expect(
        await database.client.membership.findMany({
          where: { organizationId: result.organization.id },
        }),
      ).toMatchObject([{ userId: actor.userId, orgRole: 'owner' }]);
    });
    await expect(sessions.authenticate(old.token)).rejects.toThrow('Authentication failed.');
    expect((await sessions.authenticate(result.session.token)).user.securityVersion).toBe(1);
    expect(
      await auditLog().findFirst({ where: { organizationId: result.organization.id } }),
    ).toMatchObject({
      action: 'organization.created',
      actorId: actor.userId,
      metadata: { ownerId: actor.userId },
    });
    expect(await prisma.organization.count()).toBe(0);
  });

  it('rejects a missing password, invalid settings and stale callers before creating resources', async () => {
    const actor = await account();
    await expect(
      commands.create(actor, { name: 'Invalid', slug: 'bad\n' }, password, {}),
    ).rejects.toMatchObject({ code: 'invalid_resource_slug' });
    await expect(
      commands.create(actor, { name: 'Denied', slug: 'denied' }, new Secret('wrong'), {}),
    ).rejects.toThrow('Authentication failed.');
    await expect(
      commands.create(
        { ...actor, securityVersion: 1 },
        { name: 'Stale', slug: 'stale' },
        password,
        {},
      ),
    ).rejects.toThrow('Authentication failed.');
    expect(
      (await admin.query('SELECT id FROM memberships WHERE user_id=$1', [actor.userId])).rowCount,
    ).toBe(0);
  });

  it('allows owner/admin settings changes and denies members, outsiders and removed membership', async () => {
    const owner = await account();
    const administrator = await account();
    const member = await account();
    const outsider = await account();
    const { organization } = await commands.create(
      owner,
      { name: 'Managed', slug: 'managed' },
      password,
      {},
    );
    await database.runTenant(organization.id, async () => {
      await database.client.membership.createMany({
        data: [
          {
            id: uuidv7(),
            organizationId: organization.id,
            userId: administrator.userId,
            orgRole: 'admin',
          },
          {
            id: uuidv7(),
            organizationId: organization.id,
            userId: member.userId,
            orgRole: 'member',
          },
        ],
      });
    });
    const settings = { name: 'Renamed', slug: 'renamed' };
    await commands.update({ ...owner, securityVersion: 1 }, organization.id, settings);
    await commands.update(administrator, organization.id, { ...settings, name: 'By admin' });
    for (const actor of [member, outsider])
      await expect(commands.update(actor, organization.id, settings)).rejects.toMatchObject({
        code: 'resource_not_found',
      });
    await database.runTenant(organization.id, () =>
      database.client.membership.deleteMany({ where: { userId: administrator.userId } }),
    );
    await expect(commands.update(administrator, organization.id, settings)).rejects.toMatchObject({
      code: 'resource_not_found',
    });
    await expect(commands.update(owner, organization.id, settings)).rejects.toThrow(
      'Authentication failed.',
    );
    await expect(
      commands.update({ ...owner, securityVersion: 1 }, uuidv7(), settings),
    ).rejects.toMatchObject({ code: 'resource_not_found' });
    expect(
      await auditLog().count({
        where: { organizationId: organization.id, action: 'organization.updated' },
      }),
    ).toBe(2);
  });

  it('returns a stable conflict for concurrent creation and SQL-aborted rename without leaking another tenant', async () => {
    const actors = [await account(), await account()];
    const results = await Promise.allSettled(
      actors.map((actor) =>
        commands.create(actor, { name: 'Contended', slug: 'contended' }, password, {}),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'organization_slug_unavailable' },
    });
    const actor = await account();
    const { organization } = await commands.create(
      actor,
      { name: 'Original', slug: 'original' },
      password,
      {},
    );
    await expect(
      commands.update({ ...actor, securityVersion: 1 }, organization.id, {
        name: 'Conflict',
        slug: 'contended',
      }),
    ).rejects.toMatchObject({
      code: 'organization_slug_unavailable',
      message: 'Organization slug is unavailable.',
    });
    await database.runTenant(organization.id, async () => {
      expect(
        await database.client.organization.findUnique({ where: { id: organization.id } }),
      ).toMatchObject({ name: 'Original', slug: 'original' });
    });
    expect(
      await auditLog().count({
        where: { organizationId: organization.id, action: 'organization.updated' },
      }),
    ).toBe(0);
    expect(await prisma.organization.count()).toBe(0);
  });

  it('rolls back organization, owner and session changes when either audit entry is rejected', async () => {
    for (const rejectedAction of ['organization.created', 'identity.session_rotated']) {
      const actor = await account();
      const original = await sessions.login({
        email: `${actor.userId}@example.com`,
        password,
        ...client,
      });
      // Static allowlisted fixture actions; PostgreSQL DDL cannot parameterize CHECK literals.
      await admin.query(
        rejectedAction === 'organization.created'
          ? "ALTER TABLE audit_events ADD CONSTRAINT reject_org_audit CHECK (action <> 'organization.created') NOT VALID"
          : "ALTER TABLE audit_events ADD CONSTRAINT reject_org_audit CHECK (action <> 'identity.session_rotated') NOT VALID",
      );
      try {
        await expect(
          commands.create(
            actor,
            { name: 'Rollback', slug: `rollback-${actor.userId.slice(-8)}` },
            password,
            {},
          ),
        ).rejects.toThrow();
      } finally {
        await admin.query('ALTER TABLE audit_events DROP CONSTRAINT reject_org_audit');
      }
      expect(
        (await admin.query('SELECT id FROM memberships WHERE user_id=$1', [actor.userId])).rowCount,
      ).toBe(0);
      expect(
        (
          await admin.query('SELECT id FROM organizations WHERE slug=$1', [
            `rollback-${actor.userId.slice(-8)}`,
          ])
        ).rowCount,
      ).toBe(0);
      expect((await sessions.authenticate(original.token)).user.securityVersion).toBe(0);
      expect(
        await auditLog().count({
          where: { actorId: actor.userId, action: 'organization.created' },
        }),
      ).toBe(0);
    }
  });

  it('rolls back organization settings when their audit fails', async () => {
    const actor = await account();
    const { organization } = await commands.create(
      actor,
      { name: 'Preserved', slug: 'preserved' },
      password,
      {},
    );
    await admin.query(
      "ALTER TABLE audit_events ADD CONSTRAINT reject_org_update CHECK (action <> 'organization.updated') NOT VALID",
    );
    try {
      await expect(
        commands.update({ ...actor, securityVersion: 1 }, organization.id, {
          name: 'Not saved',
          slug: 'not-saved',
        }),
      ).rejects.toThrow();
    } finally {
      await admin.query('ALTER TABLE audit_events DROP CONSTRAINT reject_org_update');
    }
    await database.runTenant(organization.id, async () => {
      expect(
        await database.client.organization.findUnique({ where: { id: organization.id } }),
      ).toMatchObject({ name: 'Preserved', slug: 'preserved' });
    });
  });

  async function account(): Promise<SecurityContext> {
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
    return { userId, securityVersion: 0, ...client };
  }
});
