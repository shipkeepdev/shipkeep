import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

describe('account-bound organization discovery against PostgreSQL', () => {
  let close: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  let database: PrismaUnitOfWork;
  const users = [uuidv7(), uuidv7(), uuidv7(), uuidv7()] as const;
  const orgs = [uuidv7(), uuidv7()] as const;

  beforeAll(async () => {
    const fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
    database = fixture.app.get(PrismaUnitOfWork);
    for (const [index, id] of users.entries())
      await prisma.user.create({
        data: {
          id,
          email: `discovery-${String(index)}@example.com`,
          passwordHash: 'fixture-hash',
          status: index === 2 ? 'disabled' : index === 3 ? 'pending' : 'active',
          emailVerifiedAt: index === 3 ? null : new Date(),
        },
      });
    for (const [index, id] of orgs.entries())
      await database.runTenant(id, async () => {
        await database.client.organization.create({
          data: { id, name: 'Discovery fixture', slug: `discovery-${String(index)}` },
        });
        const member = await database.client.membership.create({
          data: { id: uuidv7(), organizationId: id, userId: users[index], orgRole: 'owner' },
        });
        const project = await database.client.project.create({
          data: { id: uuidv7(), organizationId: id, name: 'Private', slug: 'private' },
        });
        const environment = await database.client.environment.create({
          data: { id: uuidv7(), organizationId: id, projectId: project.id, name: 'production' },
        });
        await database.client.roleBinding.create({
          data: {
            id: uuidv7(),
            organizationId: id,
            projectId: project.id,
            environmentId: environment.id,
            membershipId: member.id,
            role: 'viewer',
          },
        });
      });
    await database.runTenant(orgs[1], async () => {
      for (const userId of [users[0], users[2], users[3]])
        await database.client.membership.create({
          data: { id: uuidv7(), organizationId: orgs[1], userId, orgRole: 'member' },
        });
    });
  });
  afterAll(async () => {
    await close?.();
  });

  it('lists only the active verified account memberships and organization metadata', async () => {
    await Promise.all(
      users.slice(0, 2).map((userId, index) =>
        database.runAccountDiscovery(userId, async () => {
          const rows = await database.client.membership.findMany({
            include: { organization: true },
            orderBy: { organizationId: 'asc' },
          });
          expect(rows.map((row) => row.organizationId)).toEqual(
            index === 0 ? [...orgs] : [orgs[1]],
          );
          expect(
            rows.every(
              (row) => row.userId === userId && row.organization.id === row.organizationId,
            ),
          ).toBe(true);
          expect(await database.client.organization.count()).toBe(index === 0 ? 2 : 1);
          expect(await database.client.project.count()).toBe(0);
          expect(await database.client.environment.count()).toBe(0);
          expect(await database.client.roleBinding.count()).toBe(0);
        }),
      ),
    );
    expect(await prisma.membership.count()).toBe(0);
    expect(await prisma.organization.count()).toBe(0);
  });

  it.each([users[2], users[3], uuidv7()])(
    'denies discovery for disabled, unverified or unknown account %s',
    async (userId) => {
      await database.runAccountDiscovery(userId, async () => {
        expect(await database.client.membership.count()).toBe(0);
        expect(await database.client.organization.count()).toBe(0);
      });
    },
  );

  it('grants no tenant write access even to an organization owner', async () => {
    await database.runAccountDiscovery(users[0], async () => {
      expect(
        (await database.client.organization.updateMany({ data: { name: 'Forbidden' } })).count,
      ).toBe(0);
      expect((await database.client.membership.deleteMany()).count).toBe(0);
    });
    await expect(
      database.runAccountDiscovery(users[0], () =>
        database.client.project.create({
          data: {
            id: uuidv7(),
            organizationId: orgs[0],
            name: 'Forbidden',
            slug: 'forbidden',
          },
        }),
      ),
    ).rejects.toThrow('Tenant storage temporarily unavailable.');
    await database.runTenant(orgs[0], async () => {
      expect(
        await database.client.organization.findUnique({ where: { id: orgs[0] } }),
      ).toMatchObject({ name: 'Discovery fixture' });
      expect(await database.client.project.count()).toBe(1);
      expect(await database.client.membership.count()).toBe(1);
    });
  });

  it('forbids nested account/tenant switches and clears both contexts in an outer transaction', async () => {
    await database.run(async () => {
      await database.runAccountDiscovery(users[0], async () => {
        await expect(
          database.runAccountDiscovery(users[1], () => Promise.resolve()),
        ).rejects.toMatchObject({ code: 'tenant_context_conflict' });
        await expect(database.runTenant(orgs[0], () => Promise.resolve())).rejects.toMatchObject({
          code: 'tenant_context_conflict',
        });
        await database.runAccountDiscovery(users[0], async () => {
          expect(await database.client.organization.count()).toBe(2);
        });
      });
      expect(await database.client.organization.count()).toBe(0);
      await database.runTenant(orgs[0], async () => {
        await expect(
          database.runAccountDiscovery(users[0], () => Promise.resolve()),
        ).rejects.toMatchObject({ code: 'tenant_context_conflict' });
        expect(await database.client.membership.count()).toBe(1);
      });
      expect(await database.client.membership.count()).toBe(0);
    });
  });

  it('uses current account status and rejects malformed discovery context', async () => {
    await expect(
      database.runAccountDiscovery('invalid', () => Promise.resolve()),
    ).rejects.toMatchObject({ code: 'invalid_account_context' });
    await prisma.user.update({ where: { id: users[0] }, data: { status: 'disabled' } });
    try {
      await database.runAccountDiscovery(users[0], async () => {
        expect(await database.client.organization.count()).toBe(0);
      });
    } finally {
      await prisma.user.update({ where: { id: users[0] }, data: { status: 'active' } });
    }
  });

  it('stops discovering an organization immediately after membership removal', async () => {
    await database.runTenant(orgs[1], async () => {
      await database.client.membership.deleteMany({ where: { userId: users[0] } });
    });
    await database.runAccountDiscovery(users[0], async () => {
      expect((await database.client.organization.findMany()).map((row) => row.id)).toEqual([
        orgs[0],
      ]);
    });
  });
});
