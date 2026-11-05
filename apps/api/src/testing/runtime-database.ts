import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Client } from 'pg';

/** Only for a disposable integration database. The returned URL is private fixture state. */
export async function runtimeDatabase(
  adminUrl: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const password = randomBytes(24).toString('hex');
  try {
    await admin.query('BEGIN');
    await admin.query(
      await readFile(resolve(__dirname, '../../../../deploy/postgres/runtime-role.sql'), 'utf8'),
    );
    // Fixed role name and generated hexadecimal password, not request input.
    await admin.query(
      `CREATE ROLE shipkeep_runtime_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
    );
    await admin.query(
      'GRANT shipkeep_runtime TO shipkeep_runtime_test WITH INHERIT TRUE, SET FALSE',
    );
    await admin.query('COMMIT');
  } catch (error: unknown) {
    await admin.query('ROLLBACK');
    await admin.end();
    throw error;
  }
  const url = new URL(adminUrl);
  url.username = 'shipkeep_runtime_test';
  url.password = password;
  return {
    url: url.toString(),
    close: async () => {
      try {
        await admin.query('DROP OWNED BY shipkeep_runtime_test,shipkeep_runtime CASCADE');
        await admin.query('DROP ROLE shipkeep_runtime_test,shipkeep_runtime');
      } finally {
        await admin.end();
      }
    },
  };
}
