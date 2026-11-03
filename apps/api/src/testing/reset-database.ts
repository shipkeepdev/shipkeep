import { Client } from 'pg';

/**
 * Drops every object of the `public` schema so an integration test file starts from an empty
 * database. Integration files run serially (`fileParallelism: false`) and may share one database
 * (the CI service container); each file brings its own throwaway KEK, so rows written by a
 * previous file would be undecryptable noise. Never call this with a non-test database URL.
 */
export async function resetDatabase(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
}
