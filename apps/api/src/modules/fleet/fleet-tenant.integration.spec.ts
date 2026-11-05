import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { applyMigrations } from '../../testing/apply-migrations';
import { resetDatabase } from '../../testing/reset-database';
import { POSTGRES_TEST_IMAGE } from '../../testing/postgres-image';

const migrations = resolve(__dirname, '../../../prisma/migrations');
const tables = ['nodes', 'join_tokens'] as const;

describe('fleet organization references against PostgreSQL', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let client: Client;
  const org = uuidv7();
  const user = uuidv7();

  beforeAll(async () => {
    if (!process.env['DATABASE_URL'])
      container = await new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
    const url = container?.getConnectionUri() ?? process.env['DATABASE_URL'] ?? '';
    await resetDatabase(url);
    await applyMigrations(url, migrations);
    client = new Client({ connectionString: url });
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO users (id,email,password_hash,status,email_verified_at,updated_at) VALUES ($1,'fleet-owner@example.com','fixture-hash','active',now(),now())",
      [user],
    );
    await client.query(
      "INSERT INTO organizations (id,name,slug,updated_at) VALUES ($1,'Fleet fixture','fleet-fixture',now())",
      [org],
    );
    await client.query(
      "INSERT INTO memberships (id,organization_id,user_id,org_role,updated_at) VALUES ($1,$2,$3,'owner',now())",
      [uuidv7(), org, user],
    );
    await client.query('COMMIT');
  });
  afterAll(async () => {
    await client.end();
    await container?.stop();
  });
  beforeEach(async () => {
    await client.query('DELETE FROM join_tokens');
    await client.query('DELETE FROM nodes');
  });

  it.each(tables)('rejects orphan %s inserts and updates', async (table) => {
    await expect(insert(table, uuidv7())).rejects.toMatchObject({ code: '23503' });
    const id = await insert(table, org);
    await expect(
      client.query(`UPDATE ${table} SET organization_id=$1 WHERE id=$2`, [uuidv7(), id]),
    ).rejects.toMatchObject({ code: '23503' });
    expect(
      (await client.query(`SELECT organization_id FROM ${table} WHERE id=$1`, [id])).rows,
    ).toEqual([{ organization_id: org }]);
  });

  it.each(tables)('preserves %s when organization deletion is attempted', async (table) => {
    const id = await insert(table, org);
    await expect(
      client.query('DELETE FROM organizations WHERE id=$1', [org]),
    ).rejects.toMatchObject({ code: '23503' });
    expect((await client.query(`SELECT id FROM ${table} WHERE id=$1`, [id])).rowCount).toBe(1);
    expect(
      (await client.query('SELECT id FROM memberships WHERE organization_id=$1', [org])).rowCount,
    ).toBe(1);
  });

  it.each(tables)(
    'refuses a legacy orphan in %s without deleting or reassigning it',
    async (table) => {
      const sql = await readFile(
        resolve(migrations, '20261105100000_fleet_organizations/migration.sql'),
        'utf8',
      );
      // Reproduce the previous schema in this isolated test database.
      for (const name of tables)
        await client.query(`ALTER TABLE ${name} DROP CONSTRAINT ${name}_organization_id_fkey`);
      const missing = uuidv7();
      const id = await insert(table, missing);
      try {
        await client.query('BEGIN');
        await expect(client.query(sql)).rejects.toMatchObject({
          code: '23503',
          message: 'Fleet records reference missing organizations.',
        });
        await client.query('ROLLBACK');
        expect(
          (await client.query(`SELECT organization_id FROM ${table} WHERE id=$1`, [id])).rows,
        ).toEqual([{ organization_id: missing }]);
        expect(
          (await client.query('SELECT id FROM organizations WHERE id=$1', [missing])).rowCount,
        ).toBe(0);
      } finally {
        await client.query('ROLLBACK');
        await client.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
        await client.query(sql);
      }
    },
  );

  async function insert(table: (typeof tables)[number], organizationId: string): Promise<string> {
    const id = uuidv7();
    if (table === 'nodes')
      await client.query(
        "INSERT INTO nodes (id,organization_id,name,status,labels,facts,lease_epoch,created_at) VALUES ($1,$2,'fixture-node','enrolling','{}','{}',1,now())",
        [id, organizationId],
      );
    else
      await client.query(
        "INSERT INTO join_tokens (id,organization_id,token_hash,created_at,expires_at) VALUES ($1,$2,$3,now(),now()+interval '5 minutes')",
        [id, organizationId, id.replaceAll('-', '').repeat(2)],
      );
    return id;
  }
});
