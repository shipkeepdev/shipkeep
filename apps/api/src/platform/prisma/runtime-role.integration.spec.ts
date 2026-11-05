import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Secret } from '@shipkeep/domain';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { AccountCommands } from '../../modules/identity/application/account-commands';
import {
  IDENTITY_MAILER,
  type IdentityMailer,
} from '../../modules/identity/application/identity-ports';
import { integrationApp } from '../../testing/integration-app';
import { JobQueue } from '../jobs/job-queue';

import { PrismaService } from './prisma.service';
import { PrismaUnitOfWork } from './prisma-unit-of-work';

describe('runtime-role provisioning against PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let admin: Client;
  let prisma: PrismaService;
  let database: PrismaUnitOfWork;
  let closeApp: (() => Promise<void>) | undefined;
  let closeAdmin: (() => Promise<void>) | undefined;
  let verify: Secret | undefined;
  const org = uuidv7();
  const mailer: IdentityMailer = {
    send: (message) => {
      verify = message.token;
      return Promise.resolve();
    },
  };

  beforeAll(async () => {
    fixture = await integrationApp([{ token: IDENTITY_MAILER, value: mailer }], {
      restrictedDatabase: true,
    });
    closeApp = fixture.close;
    prisma = fixture.app.get(PrismaService);
    database = fixture.app.get(PrismaUnitOfWork);
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    closeAdmin = () => admin.end();
  });
  afterAll(async () => {
    await closeAdmin?.();
    await closeApp?.();
  });

  it('runs identity, audit and tenant transactions with the provisioned restricted login', async () => {
    const accounts = fixture.app.get(AccountCommands);
    await accounts.register('runtime@example.com', new Secret('runtime fixture password phrase'));
    if (!verify) throw new Error('missing verification fixture');
    await accounts.verifyEmail(verify, new Secret('runtime fixture password phrase'));
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'runtime@example.com' } });
    expect(user.status).toBe('active');
    expect(
      (await prisma.auditEvent.findMany({ where: { targetId: user.id } })).map((row) => row.action),
    ).toEqual(['identity.registered', 'identity.email_verified']);
    await database.runTenant(org, async () => {
      await database.client.organization.create({
        data: { id: org, name: 'Runtime fixture', slug: 'runtime-fixture' },
      });
      await database.client.membership.create({
        data: { id: uuidv7(), organizationId: org, userId: user.id, orgRole: 'owner' },
      });
      expect(await database.client.organization.count()).toBe(1);
    });
    expect(await prisma.organization.count()).toBe(0);
  });

  it('denies audit and key rewrites, tenant DDL and access to administrative migration state', async () => {
    for (const execute of [
      () => prisma.$executeRaw`DELETE FROM public.audit_events`,
      () => prisma.$executeRaw`UPDATE public.audit_events SET action='forged'`,
      () => prisma.$executeRaw`DELETE FROM public.data_encryption_keys`,
      () => prisma.$executeRaw`UPDATE public.data_encryption_keys SET kek_version=kek_version`,
      () => prisma.$executeRaw`DELETE FROM public.installation_keys`,
      () => prisma.$executeRaw`UPDATE public.installation_keys SET kind=kind`,
      () => prisma.$executeRaw`TRUNCATE public.projects`,
      () => prisma.$executeRaw`ALTER TABLE public.projects DISABLE ROW LEVEL SECURITY`,
      () => prisma.$executeRaw`CREATE TABLE public.untrusted (id integer)`,
      () => prisma.$executeRaw`SELECT * FROM public._shipkeep_test_migrations`,
    ])
      await expect(execute()).rejects.toThrow();
    expect(await prisma.auditEvent.count()).toBe(2);
  });

  it('can reapply grants and transfer existing pg-boss objects without losing queued work', async () => {
    const queue = fixture.app.get(JobQueue);
    await queue.createQueue('runtime-fixture');
    const id = await queue.send('runtime-fixture', { example: true });
    const sql = await readFile(
      resolve(__dirname, '../../../../../deploy/postgres/runtime-role.sql'),
      'utf8',
    );
    // Simulate the legacy queue schema owned by the migration login before runtime separation.
    await admin.query('ALTER SCHEMA shipkeep_jobs OWNER TO CURRENT_USER');
    await admin.query('ALTER TABLE shipkeep_jobs.job OWNER TO CURRENT_USER');
    for (let attempt = 0; attempt < 2; attempt++) {
      await admin.query('BEGIN');
      await admin.query(sql);
      await admin.query('COMMIT');
    }
    expect((await queue.fetch('runtime-fixture')).map((job) => job.id)).toContain(id);
    await queue.createQueue('runtime-after-upgrade');
    expect(await queue.send('runtime-after-upgrade', {})).toBeTypeOf('string');
    await database.runTenant(org, async () => {
      expect(await database.client.organization.count()).toBe(1);
    });
  });

  it('refuses an existing runtime group with privileged attributes', async () => {
    const sql = await readFile(
      resolve(__dirname, '../../../../../deploy/postgres/runtime-role.sql'),
      'utf8',
    );
    await admin.query('ALTER ROLE shipkeep_runtime BYPASSRLS');
    try {
      await expect(admin.query(sql)).rejects.toMatchObject({
        message: 'Unsafe existing Shipkeep runtime role.',
      });
    } finally {
      await admin.query('ALTER ROLE shipkeep_runtime NOBYPASSRLS');
    }
  });
});
