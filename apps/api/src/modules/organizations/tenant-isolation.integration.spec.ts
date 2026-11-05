import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { applyMigrations } from '../../testing/apply-migrations';
import { resetDatabase } from '../../testing/reset-database';

const tables = [
  'organizations',
  'memberships',
  'projects',
  'environments',
  'role_bindings',
] as const;

describe('tenant RLS and owner constraints against PostgreSQL', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let admin: Client;
  let actor: Client;
  let closeActor: (() => Promise<void>) | undefined;
  let url: string;
  let cleanup: (() => Promise<void>) | undefined;
  const users = [uuidv7(), uuidv7()];
  const orgs = [uuidv7(), uuidv7()];
  const owners = [uuidv7(), uuidv7()];
  const projects = [uuidv7(), uuidv7()];
  const envs = [uuidv7(), uuidv7()];

  beforeAll(async () => {
    if (!process.env['DATABASE_URL'])
      container = await new PostgreSqlContainer('postgres:17').start();
    url = container?.getConnectionUri() ?? process.env['DATABASE_URL'] ?? '';
    await resetDatabase(url);
    await applyMigrations(url, resolve(__dirname, '../../../prisma/migrations'));
    admin = new Client({ connectionString: url });
    await admin.connect();
    cleanup = () => admin.end();
    await admin.query('CREATE ROLE shipkeep_tenant_test NOLOGIN NOSUPERUSER NOBYPASSRLS');
    cleanup = async () => {
      await admin.query('DROP OWNED BY shipkeep_tenant_test');
      await admin.query('DROP ROLE shipkeep_tenant_test');
      await admin.end();
    };
    await admin.query('GRANT shipkeep_tenant_test TO CURRENT_USER');
    await admin.query('GRANT USAGE ON SCHEMA public TO shipkeep_tenant_test');
    await admin.query(
      'GRANT SELECT (id,status,email_verified_at) ON users TO shipkeep_tenant_test',
    );
    await admin.query(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON organizations,memberships,projects,environments,role_bindings TO shipkeep_tenant_test',
    );
    actor = await restrictedClient();
    closeActor = () => actor.end();
  });
  beforeEach(async () => {
    await admin.query('DELETE FROM organizations');
    await admin.query('DELETE FROM users');
    for (let i = 0; i < 2; i++) {
      await admin.query(
        "INSERT INTO users (id,email,password_hash,status,email_verified_at,updated_at) VALUES ($1,$2,'fixture-hash','active',now(),now())",
        [users[i], `rls-${String(i)}@example.com`],
      );
      await admin.query('BEGIN');
      await admin.query(
        'INSERT INTO organizations (id,name,slug,updated_at) VALUES ($1,$2,$3,now())',
        [orgs[i], `Fixture ${String(i)}`, `fixture-${String(i)}`],
      );
      await admin.query(
        "INSERT INTO memberships (id,organization_id,user_id,org_role,updated_at) VALUES ($1,$2,$3,'owner',now())",
        [owners[i], orgs[i], users[i]],
      );
      await admin.query(
        "INSERT INTO projects (id,organization_id,name,slug,updated_at) VALUES ($1,$2,'Product','product',now())",
        [projects[i], orgs[i]],
      );
      await admin.query(
        "INSERT INTO environments (id,organization_id,project_id,name,updated_at) VALUES ($1,$2,$3,'production',now())",
        [envs[i], orgs[i], projects[i]],
      );
      await admin.query(
        "INSERT INTO role_bindings (id,organization_id,membership_id,project_id,environment_id,role,updated_at) VALUES ($1,$2,$3,$4,$5,'viewer',now())",
        [uuidv7(), orgs[i], owners[i], projects[i], envs[i]],
      );
      await admin.query('COMMIT');
    }
  });
  afterAll(async () => {
    await closeActor?.();
    await cleanup?.();
    await container?.stop();
  });

  it('denies missing-context reads and restricts every table to the transaction tenant', async () => {
    for (const table of tables)
      expect((await actor.query(`SELECT id FROM ${table}`)).rowCount).toBe(0);
    await scoped(actor, orgs[0], async () => {
      for (const table of tables) {
        expect((await actor.query(`SELECT id FROM ${table}`)).rowCount).toBe(1);
        const key = table === 'organizations' ? 'id' : 'organization_id';
        for (const query of [
          `SELECT id FROM ${table} WHERE ${key}=$1`,
          `UPDATE ${table} SET updated_at=updated_at WHERE ${key}=$1`,
          `DELETE FROM ${table} WHERE ${key}=$1`,
        ])
          expect((await actor.query(query, [orgs[1]])).rowCount).toBe(0);
      }
    });
    for (const table of tables)
      expect((await actor.query(`SELECT id FROM ${table}`)).rowCount).toBe(0);
    await scoped(actor, orgs[1], async () => {
      expect((await actor.query('SELECT id FROM projects')).rows).toEqual([{ id: projects[1] }]);
    });
  });

  it('blocks foreign writes, context changes in rows and writes without context', async () => {
    await expect(
      actor.query(
        "INSERT INTO projects (id,organization_id,name,slug,updated_at) VALUES ($1,$2,'Hidden','hidden',now())",
        [uuidv7(), orgs[0]],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await scoped(actor, orgs[0], async () => {
      expect(
        (await actor.query("UPDATE projects SET name='Forbidden' WHERE id=$1", [projects[1]]))
          .rowCount,
      ).toBe(0);
      expect((await actor.query('DELETE FROM organizations WHERE id=$1', [orgs[1]])).rowCount).toBe(
        0,
      );
    });
    await expect(
      scoped(actor, orgs[0], () =>
        actor.query(
          "INSERT INTO projects (id,organization_id,name,slug,updated_at) VALUES ($1,$2,'Foreign','foreign',now())",
          [uuidv7(), orgs[1]],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      scoped(actor, orgs[0], () =>
        actor.query("UPDATE projects SET organization_id=$1, slug='moved' WHERE id=$2", [
          orgs[1],
          projects[0],
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('forces row policies even for the table owner and rejects bypass through row_security=off', async () => {
    await admin.query('ALTER TABLE projects OWNER TO shipkeep_tenant_test');
    try {
      await scoped(actor, orgs[0], async () => {
        expect((await actor.query('SELECT id FROM projects')).rows).toEqual([{ id: projects[0] }]);
      });
      await expect(
        scoped(actor, orgs[0], async () => {
          await actor.query('SET LOCAL row_security=off');
          await actor.query('SELECT id FROM projects');
        }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await admin.query('ALTER TABLE projects OWNER TO CURRENT_USER');
    }
    const flags = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid = ANY($1::regclass[])',
      [[...tables]],
    );
    expect(flags.rows).toHaveLength(tables.length);
    expect(flags.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });

  it('requires an owner when creating an organization and prevents removing or demoting the last owner', async () => {
    const empty = uuidv7();
    await expect(
      scoped(actor, empty, () =>
        actor.query(
          "INSERT INTO organizations (id,name,slug,updated_at) VALUES ($1,'Empty','empty',now())",
          [empty],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'organizations_owner_required' });
    for (const query of [
      'DELETE FROM memberships WHERE id=$1',
      "UPDATE memberships SET org_role='admin' WHERE id=$1",
    ])
      await expect(
        scoped(actor, orgs[0], () => actor.query(query, [owners[0]])),
      ).rejects.toMatchObject({ code: '23514', constraint: 'organizations_owner_required' });
    expect((await admin.query('SELECT id FROM organizations WHERE id=$1', [empty])).rowCount).toBe(
      0,
    );
  });

  it('checks ownership even if the caller changes tenant context before commit', async () => {
    await expect(
      scoped(actor, orgs[0], async () => {
        await actor.query('DELETE FROM memberships WHERE id=$1', [owners[0]]);
        await actor.query("SELECT set_config('app.org_id',$1,true)", [orgs[1]]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('allows an atomic ownership transfer and organization deletion without leaving stale context', async () => {
    await scoped(actor, orgs[0], async () => {
      await actor.query("UPDATE memberships SET org_role='member' WHERE id=$1", [owners[0]]);
      await actor.query(
        "INSERT INTO memberships (id,organization_id,user_id,org_role,updated_at) VALUES ($1,$2,$3,'owner',now())",
        [uuidv7(), orgs[0], users[1]],
      );
    });
    expect(
      (
        await admin.query(
          "SELECT user_id FROM memberships WHERE organization_id=$1 AND org_role='owner'",
          [orgs[0]],
        )
      ).rows,
    ).toEqual([{ user_id: users[1] }]);
    await scoped(actor, orgs[0], () =>
      actor.query('DELETE FROM organizations WHERE id=$1', [orgs[0]]),
    );
    expect((await actor.query('SELECT id FROM organizations')).rowCount).toBe(0);
  });

  it.each(['READ COMMITTED', 'REPEATABLE READ'] as const)(
    'serializes simultaneous owner removals under %s',
    async (isolation) => {
      const second = uuidv7();
      await admin.query(
        "INSERT INTO memberships (id,organization_id,user_id,org_role,updated_at) VALUES ($1,$2,$3,'owner',now())",
        [second, orgs[0], users[1]],
      );
      const other = await restrictedClient();
      try {
        let arrivals = 0;
        let release: (() => void) | undefined;
        const ready = new Promise<void>((resolve) => {
          release = resolve;
        });
        const remove = (connection: Client, id: string | undefined) =>
          scoped(
            connection,
            orgs[0],
            async () => {
              if (++arrivals === 2) release?.();
              await ready;
              await connection.query('DELETE FROM memberships WHERE id=$1', [id]);
            },
            isolation,
          );
        const attempts = await Promise.allSettled([
          remove(actor, owners[0]),
          remove(other, second),
        ]);
        expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const failure = attempts.find((result) => result.status === 'rejected');
        expect(failure?.status === 'rejected' ? failure.reason : undefined).toMatchObject({
          code: isolation === 'READ COMMITTED' ? '23514' : '40001',
        });
        expect(
          (
            await admin.query(
              "SELECT id FROM memberships WHERE organization_id=$1 AND org_role='owner'",
              [orgs[0]],
            )
          ).rowCount,
        ).toBe(1);
      } finally {
        await other.end();
      }
    },
  );

  async function restrictedClient(): Promise<Client> {
    const connection = new Client({ connectionString: url, statement_timeout: 10000 });
    await connection.connect();
    await connection.query('SET ROLE shipkeep_tenant_test');
    return connection;
  }
  async function scoped<T>(
    connection: Client,
    organizationId: string | undefined,
    operation: () => Promise<T>,
    isolation: 'READ COMMITTED' | 'REPEATABLE READ' = 'READ COMMITTED',
  ): Promise<T> {
    await connection.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    try {
      await connection.query("SELECT set_config('app.org_id',$1,true)", [organizationId]);
      const result = await operation();
      await connection.query('COMMIT');
      return result;
    } catch (error: unknown) {
      await connection.query('ROLLBACK');
      throw error;
    }
  }
});
