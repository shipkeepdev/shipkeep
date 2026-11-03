import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from 'pg';

/**
 * Applies the Prisma migrations of apps/api/prisma/migrations to a database, for integration
 * tests. Reading the SQL files directly keeps the tests free of any process spawning
 * (CLAUDE.md, rule 1); `prisma migrate deploy` remains the tool for real deployments.
 */
export async function applyMigrations(databaseUrl: string, migrationsDir: string): Promise<void> {
  const entries = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const name of entries) {
      const sql = await readFile(join(migrationsDir, name, 'migration.sql'), 'utf8');
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}
