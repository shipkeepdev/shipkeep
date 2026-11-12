import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { integrationApp } from '../../testing/integration-app';

type Env = Readonly<Record<string, string | undefined>>;
/** The script ships in the control plane image, outside this project: load it as the image does. */
interface Provisioning {
  ProvisioningError: new () => Error;
  runtimeTargets: (env: Env) => { admin: URL; runtime: URL };
  provisionRuntime: (env: Env) => Promise<void>;
}
const SCRIPT = resolve(__dirname, '../../../../../deploy/postgres/provision-runtime.mjs');

const ADMIN = 'postgresql://admin:admin-fixture@db.example.com:5432/shipkeep';
const RUNTIME = 'postgresql://shipkeep_app:runtime-fixture@db.example.com:5432/shipkeep';

describe('runtime login provisioning (deploy/postgres/provision-runtime.mjs)', () => {
  let ProvisioningError: Provisioning['ProvisioningError'];
  let runtimeTargets: Provisioning['runtimeTargets'];
  let provisionRuntime: Provisioning['provisionRuntime'];
  beforeAll(async () => {
    ({ ProvisioningError, runtimeTargets, provisionRuntime } = (await import(
      /* @vite-ignore */ pathToFileURL(SCRIPT).href
    )) as Provisioning);
  });

  it.each([
    ['a missing administrator URL', { DATABASE_URL: RUNTIME }],
    ['a missing runtime URL', { MIGRATION_DATABASE_URL: ADMIN }],
    ['text that is not a URL', { MIGRATION_DATABASE_URL: ADMIN, DATABASE_URL: '; DROP ROLE x' }],
    ['another protocol', { MIGRATION_DATABASE_URL: ADMIN, DATABASE_URL: 'file:///etc/passwd' }],
    [
      'another server',
      { MIGRATION_DATABASE_URL: ADMIN, DATABASE_URL: RUNTIME.replace('db.', 'evil.') },
    ],
    [
      'another database',
      { MIGRATION_DATABASE_URL: ADMIN, DATABASE_URL: RUNTIME.replace('/shipkeep', '/postgres') },
    ],
    [
      'another login name',
      { MIGRATION_DATABASE_URL: ADMIN, DATABASE_URL: RUNTIME.replace('shipkeep_app', 'postgres') },
    ],
    [
      'an injected login name',
      {
        MIGRATION_DATABASE_URL: ADMIN,
        DATABASE_URL: RUNTIME.replace('shipkeep_app', 'shipkeep_app%22%20SUPERUSER%20--'),
      },
    ],
    ['the administrator as the API login', { MIGRATION_DATABASE_URL: ADMIN, DATABASE_URL: ADMIN }],
    [
      'no runtime password',
      { MIGRATION_DATABASE_URL: ADMIN, DATABASE_URL: RUNTIME.replace(':runtime-fixture', '') },
    ],
    [
      'a connection option that weakens TLS',
      {
        MIGRATION_DATABASE_URL: `${ADMIN}?sslmode=disable`,
        DATABASE_URL: `${RUNTIME}?sslmode=disable`,
      },
    ],
    [
      'an unknown connection option',
      {
        MIGRATION_DATABASE_URL: `${ADMIN}?options=-c%20role%3Dpostgres`,
        DATABASE_URL: `${RUNTIME}?options=-c%20role%3Dpostgres`,
      },
    ],
    [
      'verified TLS on one URL only',
      { MIGRATION_DATABASE_URL: ADMIN, DATABASE_URL: `${RUNTIME}?sslmode=verify-full` },
    ],
  ])('refuses %s without echoing a credential', (_, env) => {
    let refusal: unknown;
    try {
      runtimeTargets(env);
    } catch (error: unknown) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ProvisioningError);
    const message = (refusal as Error).message;
    expect(message).not.toContain('fixture');
    expect(message).not.toContain('DROP');
  });

  it('accepts an administrator and a separate shipkeep_app login on the same database', () => {
    const targets = runtimeTargets({ MIGRATION_DATABASE_URL: ADMIN, DATABASE_URL: RUNTIME });
    expect(targets.runtime.username).toBe('shipkeep_app');
  });

  it('accepts verified TLS when both URLs ask for it', () => {
    const targets = runtimeTargets({
      MIGRATION_DATABASE_URL: `${ADMIN}?sslmode=verify-full`,
      DATABASE_URL: `${RUNTIME}?sslmode=verify-full`,
    });
    expect(targets.admin.search).toBe('?sslmode=verify-full');
  });

  describe('against PostgreSQL', () => {
    let fixture: Awaited<ReturnType<typeof integrationApp>>;
    let admin: Client;
    let env: { MIGRATION_DATABASE_URL: string; DATABASE_URL: string };
    const runtimeUrl = (password: string): string => {
      const url = new URL(fixture.databaseUrl);
      url.username = 'shipkeep_app';
      url.password = password;
      return url.toString();
    };
    const dropLogin = async (): Promise<void> => {
      const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname='shipkeep_app'");
      if (exists.rowCount) await admin.query('DROP ROLE shipkeep_app');
    };

    beforeAll(async () => {
      fixture = await integrationApp();
      admin = new Client({ connectionString: fixture.databaseUrl });
      await admin.connect();
      await dropLogin();
      env = {
        MIGRATION_DATABASE_URL: fixture.databaseUrl,
        DATABASE_URL: runtimeUrl('first fixture password'),
      };
    });
    afterAll(async () => {
      try {
        await dropLogin();
        await admin.query('DROP OWNED BY shipkeep_runtime CASCADE');
        await admin.query('DROP ROLE shipkeep_runtime');
      } finally {
        await admin.end();
        await fixture.close();
      }
    });

    it('creates a login that reads tenant tables through the group and owns nothing', async () => {
      await provisionRuntime(env);
      // Running it again, as every upgrade does, changes nothing.
      await provisionRuntime(env);

      const role = await admin.query<Record<string, boolean>>(
        "SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname='shipkeep_app'",
      );
      expect(Object.values(role.rows[0] ?? { missing: true })).toEqual([
        false,
        false,
        false,
        false,
        false,
      ]);
      const runtime = new Client({ connectionString: env.DATABASE_URL });
      await runtime.connect();
      try {
        await expect(runtime.query('SELECT count(*) FROM users')).resolves.toBeDefined();
        await expect(runtime.query('CREATE TABLE public.intruder (id int)')).rejects.toThrow();
        await expect(runtime.query('SET ROLE shipkeep_runtime')).rejects.toThrow();
      } finally {
        await runtime.end();
      }
    });

    it('never replaces the password of an existing login', async () => {
      const other = { ...env, DATABASE_URL: runtimeUrl('second fixture password') };
      const failure: unknown = await provisionRuntime(other).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(ProvisioningError);
      // The first password still works.
      await expect(provisionRuntime(env)).resolves.toBeUndefined();
    });

    it('refuses an existing login that is a member of another role', async () => {
      await admin.query('CREATE ROLE shipkeep_fixture_group NOLOGIN');
      await admin.query('GRANT shipkeep_fixture_group TO shipkeep_app');
      try {
        await expect(provisionRuntime(env)).rejects.toBeInstanceOf(ProvisioningError);
      } finally {
        await admin.query('DROP ROLE shipkeep_fixture_group');
      }
      await expect(provisionRuntime(env)).resolves.toBeUndefined();
    });

    it('refuses an existing login with elevated attributes and leaves it untouched', async () => {
      await admin.query('ALTER ROLE shipkeep_app CREATEDB');
      try {
        await expect(provisionRuntime(env)).rejects.toBeInstanceOf(ProvisioningError);
        const role = await admin.query<{ rolcreatedb: boolean }>(
          "SELECT rolcreatedb FROM pg_roles WHERE rolname='shipkeep_app'",
        );
        expect(role.rows[0]?.rolcreatedb).toBe(true);
      } finally {
        await admin.query('ALTER ROLE shipkeep_app NOCREATEDB');
      }
    });
  });
});
