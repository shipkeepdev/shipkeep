import { Client } from 'pg';

import { tenantHttpFixture } from '../../testing/tenant-http';

import { TENANT_TABLES } from './tenant-database-role';

/** The runtime check covers what it names: the list must be every protected table. */
describe('tenant table inventory against the migrated database', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let admin: Client;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
  });
  afterAll(async () => {
    await admin.end();
    await fixture.close();
  });

  it('names every table that row-level security protects, and no other', async () => {
    const { rows } = await admin.query<{ relname: string }>(
      `SELECT c.relname FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`,
    );
    expect(rows.map((row) => row.relname).sort()).toEqual([...TENANT_TABLES].sort());
  });

  /**
   * Tables that name an organization and are read before a tenant context exists. `api_tokens`
   * belongs to a user: a token is found by its hash to authenticate the request, and its optional
   * project binding only narrows what the token may do (SPEC 8).
   */
  const OUTSIDE_TENANT_CONTEXT = ['api_tokens'];

  it('finds no other table that carries an organization without protecting its rows', async () => {
    const { rows } = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'organization_id'`,
    );
    const unprotected = rows
      .map((row) => row.table_name)
      .filter((table) => !(TENANT_TABLES as readonly string[]).includes(table));
    // A new table here is either protected and listed, or added above with its reason.
    expect(unprotected).toEqual(OUTSIDE_TENANT_CONTEXT);
  });
});
