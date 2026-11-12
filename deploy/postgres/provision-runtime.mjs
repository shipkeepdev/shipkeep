// Creates the restricted API login and applies the runtime grants of runtime-role.sql, in one
// transaction, after migrations. Shared by `pnpm dev:database-role` (loopback only) and by the
// control plane image, where it runs as `node provision-runtime.mjs` before the API starts.
//
// MIGRATION_DATABASE_URL is the database administrator; DATABASE_URL is the `shipkeep_app` login
// the API uses. An existing login keeps its password: the supplied one must already work.
// The only connection option accepted is `?sslmode=verify-full`, on both URLs or on neither:
// use it for a database reached over a network that is not private to the installation.
// Errors never include a connection string, a password or a driver message.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

const RUNTIME_LOGIN = 'shipkeep_app';
const RUNTIME_GROUP = 'shipkeep_runtime';
const PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const VERIFIED_TLS = '?sslmode=verify-full';
// A database that accepts the connection and then stalls must not hang an unattended install.
const TIMEOUTS = { connectionTimeoutMillis: 15_000, statement_timeout: 60_000 };

export class ProvisioningError extends Error {}

function parse(value, name) {
  let url;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new ProvisioningError(`${name} is missing or is not a URL.`);
  }
  if (!PROTOCOLS.has(url.protocol))
    throw new ProvisioningError(`${name} must be a postgresql:// URL.`);
  if ((url.search && url.search !== VERIFIED_TLS) || url.hash)
    throw new ProvisioningError(`${name} accepts no option except ${VERIFIED_TLS}.`);
  return url;
}

/** Validates the two connection strings and returns them parsed. */
export function runtimeTargets(env) {
  const admin = parse(env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL');
  const runtime = parse(env.DATABASE_URL, 'DATABASE_URL');
  if (
    admin.hostname !== runtime.hostname ||
    admin.port !== runtime.port ||
    admin.pathname !== runtime.pathname
  )
    throw new ProvisioningError('Both URLs must target the same server and database.');
  if (admin.search !== runtime.search)
    throw new ProvisioningError('Both URLs must use the same sslmode option.');
  if (decodeURIComponent(runtime.username) !== RUNTIME_LOGIN)
    throw new ProvisioningError(`DATABASE_URL must log in as ${RUNTIME_LOGIN}.`);
  if (admin.username === runtime.username)
    throw new ProvisioningError('The administrator and the API must use different logins.');
  if (!runtime.password) throw new ProvisioningError('DATABASE_URL needs a password.');
  return { admin, runtime };
}

export async function provisionRuntime(env) {
  const { admin: adminUrl, runtime: runtimeUrl } = runtimeTargets(env);
  const grants = await readFile(new URL('./runtime-role.sql', import.meta.url), 'utf8');
  const admin = new Client({ connectionString: adminUrl.toString(), ...TIMEOUTS });
  const runtime = new Client({ connectionString: runtimeUrl.toString(), ...TIMEOUTS });
  await admin.connect();
  try {
    await admin.query('BEGIN');
    try {
      const existing = await admin.query(
        'SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=$1',
        [RUNTIME_LOGIN],
      );
      if (existing.rows.some((row) => Object.values(row).some(Boolean)))
        throw new ProvisioningError(`The existing ${RUNTIME_LOGIN} login has elevated attributes.`);
      // Attributes are not the only way to hold privileges: a membership grants another role's.
      const memberships = await admin.query(
        `SELECT 1 FROM pg_auth_members m
           JOIN pg_roles member ON member.oid = m.member
           JOIN pg_roles granted ON granted.oid = m.roleid
          WHERE member.rolname = $1 AND (granted.rolname <> $2 OR m.admin_option)`,
        [RUNTIME_LOGIN, RUNTIME_GROUP],
      );
      if (memberships.rowCount)
        throw new ProvisioningError(
          `The existing ${RUNTIME_LOGIN} login is a member of another role, or can grant ${RUNTIME_GROUP}.`,
        );
      if (existing.rows.length === 0) {
        const statement = await admin.query(
          "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql",
          [RUNTIME_LOGIN, decodeURIComponent(runtimeUrl.password)],
        );
        await admin.query(statement.rows[0].sql);
      }
      await admin.query(grants);
      await admin.query(`GRANT ${RUNTIME_GROUP} TO ${RUNTIME_LOGIN} WITH INHERIT TRUE, SET FALSE`);
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    // Existing passwords are never overwritten; fail if the supplied credentials do not work.
    await runtime.connect();
    try {
      await runtime.query('SELECT 1');
    } finally {
      await runtime.end();
    }
  } finally {
    await admin.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await provisionRuntime(process.env);
    console.log('Database runtime role ready.');
  } catch (error) {
    console.error(
      error instanceof ProvisioningError
        ? `Database-role setup refused: ${error.message}`
        : 'Database-role setup failed. Check that migrations ran, that MIGRATION_DATABASE_URL is the administrator and that the DATABASE_URL password matches the existing login; see docs/DATABASE_ROLES.md.',
    );
    process.exitCode = 1;
  }
}
