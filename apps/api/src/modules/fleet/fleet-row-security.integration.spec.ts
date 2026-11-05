import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { applyMigrations } from '../../testing/apply-migrations';
import { fleetDatabase, type FleetDatabase } from '../../testing/fleet-database';
import { POSTGRES_TEST_IMAGE } from '../../testing/postgres-image';
import { resetDatabase } from '../../testing/reset-database';

const tables = ['nodes', 'node_certificates', 'join_tokens'] as const;
const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');

/** Fleet row security (ADR 0015) on the restricted runtime login. */
describe('fleet row security against PostgreSQL', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let db: FleetDatabase;
  let runtime: Client;
  const orgs = [uuidv7(), uuidv7()];
  const nodes = [uuidv7(), uuidv7()];
  const tokens = [uuidv7(), uuidv7()];
  const hashes = [hashOf('first fixture token'), hashOf('second fixture token')];

  beforeAll(async () => {
    if (!process.env['DATABASE_URL'])
      container = await new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
    const url = container?.getConnectionUri() ?? process.env['DATABASE_URL'] ?? '';
    await resetDatabase(url);
    await applyMigrations(url, resolve(__dirname, '../../../prisma/migrations'));
    db = await fleetDatabase(url);
    for (let i = 0; i < 2; i++) {
      await db.createOrganization(orgs[i] ?? '');
      await db.admin.query(
        "INSERT INTO nodes (id,organization_id,name,status,labels,facts,lease_epoch,created_at) VALUES ($1,$2,'fixture','active','{}','{}',1,now())",
        [nodes[i], orgs[i]],
      );
      await db.admin.query(
        "INSERT INTO node_certificates (id,organization_id,node_id,serial,not_before,not_after) VALUES ($1,$2,$3,$4,now(),now()+interval '1 day')",
        [uuidv7(), orgs[i], nodes[i], uuidv7().replaceAll('-', '')],
      );
      await db.admin.query(
        "INSERT INTO join_tokens (id,organization_id,token_hash,created_at,expires_at) VALUES ($1,$2,$3,now(),now()+interval '15 minutes')",
        [tokens[i], orgs[i], hashes[i]],
      );
    }
    runtime = new Client({ connectionString: db.runtimeUrl, statement_timeout: 10000 });
    await runtime.connect();
  });
  afterAll(async () => {
    await runtime.end();
    await db.close();
    await container?.stop();
  });

  async function within<T>(
    settings: { org?: string; hash?: string },
    work: () => Promise<T>,
  ): Promise<T> {
    await runtime.query('BEGIN');
    try {
      await runtime.query(
        "SELECT set_config('app.org_id',$1,true), set_config('app.join_token_hash',$2,true)",
        [settings.org ?? '', settings.hash ?? ''],
      );
      const result = await work();
      await runtime.query('COMMIT');
      return result;
    } catch (error: unknown) {
      await runtime.query('ROLLBACK');
      throw error;
    }
  }
  const ids = async (table: string) =>
    (await runtime.query<{ id: string }>(`SELECT id FROM ${table}`)).rows.map((row) => row.id);

  it('shows no fleet row without a tenant context', async () => {
    for (const table of tables) expect(await within({}, () => ids(table))).toEqual([]);
  });

  it('restricts every fleet table to the transaction tenant and refuses foreign writes', async () => {
    await within({ org: orgs[0] }, async () => {
      expect(await ids('nodes')).toEqual([nodes[0]]);
      expect(await ids('join_tokens')).toEqual([tokens[0]]);
      expect(await ids('node_certificates')).toHaveLength(1);
      for (const table of tables)
        for (const query of [
          `UPDATE ${table} SET organization_id=organization_id WHERE organization_id=$1`,
          `DELETE FROM ${table} WHERE organization_id=$1`,
        ])
          expect((await runtime.query(query, [orgs[1]])).rowCount).toBe(0);
    });
    await expect(
      within({ org: orgs[0] }, () =>
        runtime.query(
          "INSERT INTO nodes (id,organization_id,name,status,labels,facts,lease_epoch,created_at) VALUES ($1,$2,'foreign','enrolling','{}','{}',1,now())",
          [uuidv7(), orgs[1]],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('exposes only the presented join token, read-only, during enrollment', async () => {
    await within({ hash: hashes[1] }, async () => {
      expect(await ids('join_tokens')).toEqual([tokens[1]]);
      expect(await ids('nodes')).toEqual([]);
      expect(await ids('node_certificates')).toEqual([]);
      expect(
        (await runtime.query('UPDATE join_tokens SET used_at=now() WHERE id=$1', [tokens[1]]))
          .rowCount,
      ).toBe(0);
      expect((await runtime.query('DELETE FROM join_tokens')).rowCount).toBe(0);
    });
    expect(await within({ hash: hashOf('unknown token') }, () => ids('join_tokens'))).toEqual([]);
    // A tenant context disables the lookup: only that tenant's tokens remain visible.
    expect(await within({ org: orgs[0], hash: hashes[1] }, () => ids('join_tokens'))).toEqual([
      tokens[0],
    ]);
  });
});
