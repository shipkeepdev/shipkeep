import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from 'pg';

const TRACKING_TABLE = '_shipkeep_test_migrations';
const LOCK_KEY = 7_315_301; // arbitrary advisory lock id shared by every test process

/**
 * Applies the Prisma migrations of apps/api/prisma/migrations to a database, for integration
 * tests. Reading the SQL files directly keeps the tests free of any process spawning
 * (CLAUDE.md, rule 1); `prisma migrate deploy` remains the tool for real deployments.
 *
 * Idempotent and safe for several test files sharing one database (the CI service container):
 * applied migrations are recorded in a tracking table, migrations already deployed by the Prisma
 * CLI (`_prisma_migrations`) are honoured, and an advisory lock serializes concurrent callers.
 */
export async function applyMigrations(databaseUrl: string, migrationsDir: string): Promise<void> {
  const names = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (name text PRIMARY KEY)`);
      const applied = new Set<string>(
        (await client.query<{ name: string }>(`SELECT name FROM ${TRACKING_TABLE}`)).rows.map(
          (r) => r.name,
        ),
      );
      const prismaTable = await client.query<{ exists: boolean }>(
        "SELECT to_regclass('_prisma_migrations') IS NOT NULL AS exists",
      );
      if (prismaTable.rows[0]?.exists) {
        const deployed = await client.query<{ migration_name: string }>(
          'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL',
        );
        for (const row of deployed.rows) applied.add(row.migration_name);
      }

      for (const name of names) {
        if (applied.has(name)) continue;
        const sql = await readFile(join(migrationsDir, name, 'migration.sql'), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(`INSERT INTO ${TRACKING_TABLE} (name) VALUES ($1)`, [name]);
          await client.query('COMMIT');
        } catch (error: unknown) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}
