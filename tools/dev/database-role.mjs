// Local development only. Production uses deploy/postgres/runtime-role.sql and a private login.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

export async function provisionDevelopmentRuntime(env) {
  const adminUrl = new URL(env.MIGRATION_DATABASE_URL ?? 'invalid:');
  const runtimeUrl = new URL(env.DATABASE_URL ?? 'invalid:');
  const local = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (
    env.NODE_ENV === 'production' ||
    !local.has(adminUrl.hostname) ||
    !['postgres:', 'postgresql:'].includes(adminUrl.protocol) ||
    !['postgres:', 'postgresql:'].includes(runtimeUrl.protocol) ||
    adminUrl.hostname !== runtimeUrl.hostname ||
    adminUrl.port !== runtimeUrl.port ||
    adminUrl.pathname !== runtimeUrl.pathname ||
    runtimeUrl.username !== 'shipkeep_app' ||
    adminUrl.username === runtimeUrl.username ||
    !runtimeUrl.password ||
    runtimeUrl.search ||
    adminUrl.search ||
    runtimeUrl.hash ||
    adminUrl.hash
  )
    throw new Error('Development database-role configuration is invalid.');
  const admin = new Client({ connectionString: adminUrl.toString() });
  const runtime = new Client({ connectionString: runtimeUrl.toString() });
  await admin.connect();
  try {
    await admin.query('BEGIN');
    const existing = await admin.query(
      "SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname='shipkeep_app'",
    );
    if (existing.rows.some((row) => Object.values(row).some(Boolean)))
      throw new Error('Unsafe existing development login.');
    if (existing.rows.length === 0) {
      const statement = await admin.query(
        "SELECT format('CREATE ROLE shipkeep_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text) AS sql",
        [decodeURIComponent(runtimeUrl.password)],
      );
      await admin.query(statement.rows[0].sql);
    }
    await admin.query(
      await readFile(new URL('../../deploy/postgres/runtime-role.sql', import.meta.url), 'utf8'),
    );
    await admin.query('GRANT shipkeep_runtime TO shipkeep_app WITH INHERIT TRUE, SET FALSE');
    await admin.query('COMMIT');
    // Existing passwords are never overwritten; fail if the supplied credentials do not work.
    await runtime.connect();
    await runtime.query('SELECT 1');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  } finally {
    await runtime.end();
    await admin.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    try {
      process.loadEnvFile();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await provisionDevelopmentRuntime(process.env);
    console.log('Development database runtime role ready.');
  } catch {
    console.error(
      'Database-role setup failed. Configure a loopback MIGRATION_DATABASE_URL and a separate shipkeep_app DATABASE_URL; see docs/DATABASE_ROLES.md.',
    );
    process.exitCode = 1;
  }
}
