import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { applyMigrations } from '../../testing/apply-migrations';
import { resetDatabase } from '../../testing/reset-database';

describe('tenant schema against PostgreSQL', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let client: Client;
  let disconnect: (() => Promise<void>) | undefined;
  const user = uuidv7();
  const organizations = [uuidv7(), uuidv7()];
  const members = [uuidv7(), uuidv7()];
  const projects = [uuidv7(), uuidv7()];
  const environments = [uuidv7(), uuidv7()];

  beforeAll(async () => {
    if (!process.env['DATABASE_URL'])
      container = await new PostgreSqlContainer('postgres:17').start();
    const url = container?.getConnectionUri() ?? process.env['DATABASE_URL'] ?? '';
    await resetDatabase(url);
    await applyMigrations(url, resolve(__dirname, '../../../prisma/migrations'));
    await applyMigrations(url, resolve(__dirname, '../../../prisma/migrations'));
    client = new Client({ connectionString: url });
    await client.connect();
    disconnect = () => client.end();
  });
  beforeEach(async () => {
    await client.query('DELETE FROM organizations');
    await client.query('DELETE FROM users');
    await client.query(
      "INSERT INTO users (id,email,password_hash,status,email_verified_at,updated_at) VALUES ($1,'tenant-schema@example.com','fixture-hash','active',now(),now())",
      [user],
    );
    for (let i = 0; i < 2; i++) {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO organizations (id,name,slug,updated_at) VALUES ($1,$2,$3,now())',
        [organizations[i], `Fixture ${String(i)}`, `fixture-${String(i)}`],
      );
      await client.query(
        "INSERT INTO memberships (id,organization_id,user_id,org_role,updated_at) VALUES ($1,$2,$3,'owner',now())",
        [members[i], organizations[i], user],
      );
      await client.query(
        "INSERT INTO projects (id,organization_id,name,slug,updated_at) VALUES ($1,$2,'Product','product',now())",
        [projects[i], organizations[i]],
      );
      await client.query(
        "INSERT INTO environments (id,organization_id,project_id,name,updated_at) VALUES ($1,$2,$3,'production',now())",
        [environments[i], organizations[i], projects[i]],
      );
      await client.query('COMMIT');
    }
  });
  afterAll(async () => {
    await disconnect?.();
    await container?.stop();
  });

  it('allows equal project/environment names in separate tenants but not duplicates within a tenant', async () => {
    expect((await client.query("SELECT id FROM projects WHERE slug='product'")).rowCount).toBe(2);
    await expect(
      client.query(
        "INSERT INTO projects (id,organization_id,name,slug,updated_at) VALUES ($1,$2,'Duplicate','product',now())",
        [uuidv7(), organizations[0]],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      client.query(
        "INSERT INTO environments (id,organization_id,project_id,name,updated_at) VALUES ($1,$2,$3,'production',now())",
        [uuidv7(), organizations[0], projects[0]],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      client.query(
        "INSERT INTO memberships (id,organization_id,user_id,org_role,updated_at) VALUES ($1,$2,$3,'member',now())",
        [uuidv7(), organizations[0], user],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects cross-tenant ancestry on inserts and updates', async () => {
    await expect(
      client.query(
        "INSERT INTO environments (id,organization_id,project_id,name,updated_at) VALUES ($1,$2,$3,'staging',now())",
        [uuidv7(), organizations[0], projects[1]],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      client.query("UPDATE environments SET project_id=$1, name='foreign' WHERE id=$2", [
        projects[1],
        environments[0],
      ]),
    ).rejects.toMatchObject({ code: '23503' });
    for (const [membership, project, environment] of [
      [members[1], projects[0], null],
      [members[0], projects[1], null],
      [members[0], projects[0], environments[1]],
    ] as const)
      await expect(binding(membership, project, environment)).rejects.toMatchObject({
        code: '23503',
      });
  });

  it('rejects environment bindings to a sibling project inside the same organization', async () => {
    const sibling = uuidv7();
    await client.query(
      "INSERT INTO projects (id,organization_id,name,slug,updated_at) VALUES ($1,$2,'Sibling','sibling',now())",
      [sibling, organizations[0]],
    );
    await expect(binding(members[0], sibling, environments[0])).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('enforces one role per scope including nullable project-wide bindings', async () => {
    await binding(members[0], projects[0], null);
    await expect(binding(members[0], projects[0], null)).rejects.toMatchObject({ code: '23505' });
    await binding(members[0], projects[0], environments[0]);
    await expect(binding(members[0], projects[0], environments[0])).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('rejects unsupported roles, policies, kinds, names and slugs at the database boundary', async () => {
    await binding(members[0], projects[0], null);
    for (const [query, values] of [
      ["UPDATE memberships SET org_role='superuser' WHERE id=$1", [members[0]]],
      ["UPDATE role_bindings SET role='owner' WHERE membership_id=$1", [members[0]]],
      ["UPDATE projects SET git_write_mode='shell' WHERE id=$1", [projects[0]]],
      ["UPDATE environments SET failover_policy='automatic' WHERE id=$1", [environments[0]]],
      ["UPDATE environments SET kind='privileged' WHERE id=$1", [environments[0]]],
      ["UPDATE organizations SET name=E'bad\\nname' WHERE id=$1", [organizations[0]]],
      ["UPDATE organizations SET slug='../escape' WHERE id=$1", [organizations[0]]],
      ["UPDATE projects SET name='' WHERE id=$1", [projects[0]]],
      ["UPDATE environments SET name='UPPER' WHERE id=$1", [environments[0]]],
    ] as const)
      await expect(client.query(query, [...values])).rejects.toMatchObject({ code: '23514' });
    expect(
      (
        await client.query('SELECT protected,kind,failover_policy FROM environments WHERE id=$1', [
          environments[0],
        ])
      ).rows[0],
    ).toEqual({ protected: true, kind: 'standard', failover_policy: 'none' });
  });

  it('prevents implicit user deletion and removes only descendants of a deleted organization', async () => {
    await expect(client.query('DELETE FROM users WHERE id=$1', [user])).rejects.toMatchObject({
      code: '23503',
    });
    await client.query('DELETE FROM organizations WHERE id=$1', [organizations[0]]);
    expect(
      (
        await client.query('SELECT id FROM role_bindings WHERE organization_id=$1', [
          organizations[0],
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await client.query('SELECT id FROM environments WHERE organization_id=$1', [
          organizations[1],
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await client.query('SELECT id FROM memberships WHERE organization_id=$1', [
          organizations[1],
        ])
      ).rowCount,
    ).toBe(1);
  });

  async function binding(
    membership: string | undefined,
    project: string | undefined,
    environment: string | null | undefined,
  ) {
    return client.query(
      "INSERT INTO role_bindings (id,organization_id,membership_id,project_id,environment_id,role,updated_at) VALUES ($1,$2,$3,$4,$5,'viewer',now())",
      [uuidv7(), organizations[0], membership, project, environment],
    );
  }
});
