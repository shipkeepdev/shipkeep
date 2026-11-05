import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { Secret } from '@shipkeep/domain';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { applyMigrations } from '../../testing/apply-migrations';
import { resetDatabase } from '../../testing/reset-database';
import { AppConfig } from '../config/app-config';
import type { ParsedConfig } from '../config/config.schema';

import { PrismaService } from './prisma.service';
import { PrismaUnitOfWork } from './prisma-unit-of-work';
import { POSTGRES_TEST_IMAGE } from '../../testing/postgres-image';

describe('tenant transactions with a restricted PostgreSQL login', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let admin: Client;
  let prisma: PrismaService;
  let privileged: PrismaService;
  let database: PrismaUnitOfWork;
  const orgs = [uuidv7(), uuidv7()] as const;

  beforeAll(async () => {
    if (!process.env['DATABASE_URL'])
      container = await new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
    const url = container?.getConnectionUri() ?? process.env['DATABASE_URL'] ?? '';
    await resetDatabase(url);
    await applyMigrations(url, resolve(__dirname, '../../../prisma/migrations'));
    admin = new Client({ connectionString: url });
    await admin.connect();
    // Generated hexadecimal fixture password, never supplied by a user or printed.
    const password = randomBytes(24).toString('hex');
    await admin.query(
      `CREATE ROLE shipkeep_context_test LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE`,
    );
    await admin.query('CREATE ROLE shipkeep_context_privileged NOLOGIN BYPASSRLS');
    await admin.query('CREATE ROLE shipkeep_context_ddl NOLOGIN');
    await admin.query('GRANT USAGE ON SCHEMA public TO shipkeep_context_test');
    await admin.query(
      'GRANT SELECT (id,status,email_verified_at) ON users TO shipkeep_context_test',
    );
    await admin.query(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON organizations,memberships,projects,environments,role_bindings TO shipkeep_context_test',
    );
    for (const [index, org] of orgs.entries()) {
      const user = uuidv7();
      await admin.query('BEGIN');
      await admin.query(
        "INSERT INTO users (id,email,password_hash,status,email_verified_at,updated_at) VALUES ($1,$2,'fixture-hash','active',now(),now())",
        [user, `context-${String(index)}@example.com`],
      );
      await admin.query(
        "INSERT INTO organizations (id,name,slug,updated_at) VALUES ($1,'Context fixture',$2,now())",
        [org, `context-${String(index)}`],
      );
      await admin.query(
        "INSERT INTO memberships (id,organization_id,user_id,org_role,updated_at) VALUES ($1,$2,$3,'owner',now())",
        [uuidv7(), org, user],
      );
      await admin.query(
        "INSERT INTO projects (id,organization_id,name,slug,updated_at) VALUES ($1,$2,'Product','product',now())",
        [uuidv7(), org],
      );
      await admin.query('COMMIT');
    }
    const restrictedUrl = new URL(url);
    restrictedUrl.username = 'shipkeep_context_test';
    restrictedUrl.password = password;
    prisma = service(restrictedUrl.toString());
    privileged = service(url);
    database = new PrismaUnitOfWork(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await privileged.$disconnect();
    await admin.query(
      'DROP OWNED BY shipkeep_context_test,shipkeep_context_privileged,shipkeep_context_ddl',
    );
    await admin.query(
      'DROP ROLE shipkeep_context_test,shipkeep_context_privileged,shipkeep_context_ddl',
    );
    await admin.end();
    await container?.stop();
  });

  it('isolates concurrent requests and clears context before pooled connections are reused', async () => {
    let entered = 0;
    const barrier = barrierSignal();
    await Promise.all(
      orgs.map((org) =>
        database.runTenant(org, async () => {
          if (++entered === 2) barrier.resolve();
          await barrier.promise;
          expect(await database.client.organization.findMany({ select: { id: true } })).toEqual([
            { id: org },
          ]);
          expect(
            (await database.client.project.findMany()).map((row) => row.organizationId),
          ).toEqual([org]);
        }),
      ),
    );
    expect(await prisma.organization.count()).toBe(0);
    expect(await prisma.project.count()).toBe(0);
    expect(database.client).toBe(prisma);
  });

  it('joins nested commands, restores an outer identity transaction and rolls back tenant writes', async () => {
    const id = uuidv7();
    await expect(
      database.run(async () => {
        const transaction = database.client;
        await database.runTenant(orgs[0], async () => {
          expect(database.client).toBe(transaction);
          await database.runTenant(orgs[0], async () => {
            await database.client.project.create({
              data: { id, organizationId: orgs[0], name: 'Rolled back', slug: 'rolled-back' },
            });
          });
        });
        expect(await database.client.project.count()).toBe(0);
        throw new Error('injected outer rollback');
      }),
    ).rejects.toThrow('injected outer rollback');
    expect((await admin.query('SELECT id FROM projects WHERE id=$1', [id])).rowCount).toBe(0);
  });

  it('rejects nested tenant changes before invoking the callback', async () => {
    const operation = vi.fn();
    await database.runTenant(orgs[0], async () => {
      await expect(database.runTenant(orgs[1], operation)).rejects.toMatchObject({
        code: 'tenant_context_conflict',
      });
      expect((await database.client.organization.findMany()).map((row) => row.id)).toEqual([
        orgs[0],
      ]);
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it('accepts only a SHA-256 hex hash as enrollment context and never inside a tenant', async () => {
    const operation = vi.fn();
    for (const hash of ['', 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(63)}'`])
      await expect(database.runEnrollment(hash, operation)).rejects.toMatchObject({
        code: 'invalid_enrollment_context',
      });
    await database.runTenant(orgs[0], async () => {
      await expect(database.runEnrollment('a'.repeat(64), operation)).rejects.toMatchObject({
        code: 'tenant_context_conflict',
      });
    });
    expect(operation).not.toHaveBeenCalled();
    // The setting is local to its transaction and cleared afterwards.
    await database.run(async () => {
      await database.runEnrollment('b'.repeat(64), () => Promise.resolve());
      const [row] = await database.client.$queryRaw<{ hash: string }[]>`
        SELECT coalesce(current_setting('app.join_token_hash', true), '') AS hash`;
      expect(row?.hash).toBe('');
    });
  });

  it('rejects overlapping sibling scopes sharing an outer transaction', async () => {
    const entered = barrierSignal();
    const release = barrierSignal();
    await database.run(async () => {
      const first = database.runTenant(orgs[0], async () => {
        entered.resolve();
        await release.promise;
        expect(await database.client.organization.count()).toBe(1);
      });
      await entered.promise;
      try {
        await expect(database.runTenant(orgs[1], () => Promise.resolve())).rejects.toMatchObject({
          code: 'tenant_context_conflict',
        });
      } finally {
        release.resolve();
      }
      await first;
    });
  });

  it.each(['', 'invalid', "x'; RESET ROLE; --", '0192f0c0-0000-4000-8000-0000000000aa'])(
    'rejects invalid tenant id %j',
    async (id) => {
      const operation = vi.fn();
      await expect(database.runTenant(id, operation)).rejects.toMatchObject({
        code: 'invalid_tenant_context',
      });
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it('rejects a privileged login and hides driver diagnostics', async () => {
    const operation = vi.fn();
    await expect(new PrismaUnitOfWork(privileged).runTenant(orgs[0], operation)).rejects.toThrow(
      'Tenant storage temporarily unavailable.',
    );
    expect(operation).not.toHaveBeenCalled();
    await expect(
      database.runTenant(orgs[0], async () => {
        await database.client.$queryRaw`SELECT unknown_fixture_column FROM public.projects`;
      }),
    ).rejects.toThrow('Tenant storage temporarily unavailable.');
    expect(await prisma.project.count()).toBe(0);
  });

  it('rejects a privileged session hidden behind SET ROLE and rejects disabled row security', async () => {
    const elevated = new PrismaUnitOfWork(privileged);
    await elevated.run(async () => {
      await elevated.client.$executeRaw`SET LOCAL ROLE shipkeep_context_test`;
      await expect(elevated.runTenant(orgs[0], () => Promise.resolve())).rejects.toThrow(
        'Tenant storage temporarily unavailable.',
      );
    });
    await database.run(async () => {
      await database.client.$executeRaw`SET LOCAL row_security=off`;
      await expect(database.runTenant(orgs[0], () => Promise.resolve())).rejects.toThrow(
        'Tenant storage temporarily unavailable.',
      );
    });
  });

  it.each([
    ['ALTER ROLE shipkeep_context_test BYPASSRLS', 'ALTER ROLE shipkeep_context_test NOBYPASSRLS'],
    [
      'ALTER ROLE shipkeep_context_test CREATEROLE',
      'ALTER ROLE shipkeep_context_test NOCREATEROLE',
    ],
    [
      'GRANT TRUNCATE ON projects TO shipkeep_context_test',
      'REVOKE TRUNCATE ON projects FROM shipkeep_context_test',
    ],
    [
      'GRANT CREATE ON SCHEMA public TO shipkeep_context_test',
      'REVOKE CREATE ON SCHEMA public FROM shipkeep_context_test',
    ],
    [
      'ALTER TABLE projects OWNER TO shipkeep_context_test',
      'ALTER TABLE projects OWNER TO CURRENT_USER',
    ],
    [
      'ALTER TABLE projects NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE projects FORCE ROW LEVEL SECURITY',
    ],
    [
      'ALTER TABLE projects DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE projects ENABLE ROW LEVEL SECURITY',
    ],
    [
      'GRANT shipkeep_context_privileged TO shipkeep_context_test WITH INHERIT FALSE',
      'REVOKE shipkeep_context_privileged FROM shipkeep_context_test',
    ],
    [
      'GRANT TRUNCATE ON projects TO shipkeep_context_ddl; GRANT shipkeep_context_ddl TO shipkeep_context_test WITH INHERIT FALSE',
      'REVOKE shipkeep_context_ddl FROM shipkeep_context_test; REVOKE TRUNCATE ON projects FROM shipkeep_context_ddl',
    ],
    [
      'GRANT CREATE ON SCHEMA public TO shipkeep_context_ddl; GRANT shipkeep_context_ddl TO shipkeep_context_test WITH INHERIT FALSE',
      'REVOKE shipkeep_context_ddl FROM shipkeep_context_test; REVOKE CREATE ON SCHEMA public FROM shipkeep_context_ddl',
    ],
  ])('rechecks unsafe database configuration: %s', async (change, restore) => {
    await admin.query(change);
    const operation = vi.fn();
    try {
      await expect(database.runTenant(orgs[0], operation)).rejects.toThrow(
        'Tenant storage temporarily unavailable.',
      );
      expect(operation).not.toHaveBeenCalled();
    } finally {
      await admin.query(restore);
      // Ownership transfer rewrites ACLs; restore the original restricted grants explicitly.
      await admin.query('REVOKE ALL ON projects FROM shipkeep_context_test');
      await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON projects TO shipkeep_context_test');
    }
    await database.runTenant(orgs[0], async () => {
      expect(await database.client.project.count()).toBe(1);
    });
  });

  function service(url: string): PrismaService {
    return new PrismaService(
      new AppConfig(new ConfigService<ParsedConfig, true>({ DATABASE_URL: new Secret(url) })),
    );
  }
});

function barrierSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
