import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { applyMigrations } from '../../testing/apply-migrations';
import { resetDatabase } from '../../testing/reset-database';
import { POSTGRES_TEST_IMAGE } from '../../testing/postgres-image';

describe('identity schema against PostgreSQL', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let client: Client;
  let disconnect: (() => Promise<void>) | undefined;
  let databaseUrl: string;
  const userId = uuidv7();
  const tokenHash = 'a'.repeat(64);

  beforeAll(async () => {
    if (!process.env['DATABASE_URL']) {
      container = await new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
    }
    databaseUrl = process.env['DATABASE_URL'] ?? container?.getConnectionUri() ?? '';
    await resetDatabase(databaseUrl);
    await applyMigrations(databaseUrl, resolve(__dirname, '../../../prisma/migrations'));
    // Reapplying the migration set is safe, including installation of citext.
    await applyMigrations(databaseUrl, resolve(__dirname, '../../../prisma/migrations'));
    client = new Client({ connectionString: databaseUrl });
    disconnect = () => client.end();
    await client.connect();
  });

  beforeEach(async () => {
    await client.query('DELETE FROM users');
    await client.query(
      "INSERT INTO users (id,email,password_hash,updated_at) VALUES ($1,'Person@example.com','test-only-hash',now())",
      [userId],
    );
    await client.query(
      "INSERT INTO identity_tokens (id,user_id,purpose,token_hash,security_version,expires_at,updated_at) VALUES ($1,$2,'verify',$3,0,now()+interval '24 hours',now())",
      [uuidv7(), userId, tokenHash],
    );
  });

  afterAll(async () => {
    await disconnect?.();
    await container?.stop();
  });

  it('enforces email uniqueness independently of case and concurrent callers', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        client.query(
          "INSERT INTO users (id,email,password_hash,updated_at) VALUES ($1,'person@EXAMPLE.com','test-only-hash',now())",
          [uuidv7()],
        ),
      ),
    );
    expect(attempts.every((attempt) => attempt.status === 'rejected')).toBe(true);
    expect(
      (await client.query('SELECT id FROM users WHERE email = $1', ['PERSON@example.com'])).rows,
    ).toEqual([{ id: userId }]);
  });

  it('rejects unverified active users, unknown states and negative security versions', async () => {
    await expect(
      client.query("UPDATE users SET status = 'active' WHERE id = $1", [userId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query("UPDATE users SET status = 'root' WHERE id = $1", [userId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query('UPDATE users SET security_version = -1 WHERE id = $1', [userId]),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query(
      "UPDATE users SET status = 'active', email_verified_at = now() WHERE id = $1",
      [userId],
    );
  });

  it('rejects unknown token purposes, invalid hashes and excessive lifetimes', async () => {
    const insert = (purpose: string, digest: string, seconds: number) =>
      client.query(
        "INSERT INTO identity_tokens (id,user_id,purpose,token_hash,security_version,expires_at,updated_at) VALUES ($1,$2,$3,$4,0,now()+$5*interval '1 second',now())",
        [uuidv7(), userId, purpose, digest, seconds],
      );
    for (const [purpose, digest, seconds] of [
      ['admin', tokenHash, 60],
      ['verify', 'plaintext', 60],
      ['verify', tokenHash, 86401],
      ['reset', tokenHash, 1801],
      ['reset', tokenHash, 0],
    ] as const) {
      await expect(insert(purpose, digest, seconds)).rejects.toMatchObject({ code: '23514' });
    }
    await insert('reset', 'b'.repeat(64), 1800);
  });

  it('allows exactly one concurrent token consumer and preserves the claim after reconnect', async () => {
    const other = new Client({ connectionString: databaseUrl });
    await other.connect();
    try {
      const query =
        'UPDATE identity_tokens SET used_at = now(), updated_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING id';
      const claims = await Promise.all([
        client.query(query, [tokenHash]),
        other.query(query, [tokenHash]),
      ]);
      expect(claims.reduce((sum, claim) => sum + (claim.rowCount ?? 0), 0)).toBe(1);
    } finally {
      await other.end();
    }
    const fresh = new Client({ connectionString: databaseUrl });
    await fresh.connect();
    try {
      expect(
        (
          await fresh.query('SELECT used_at FROM identity_tokens WHERE token_hash = $1', [
            tokenHash,
          ])
        ).rows[0],
      ).toMatchObject({ used_at: expect.any(Date) as Date });
    } finally {
      await fresh.end();
    }
  });

  it('bounds session lifetimes and cascades credentials when a user is removed', async () => {
    const insert = (days: number) =>
      client.query(
        "INSERT INTO user_sessions (id,user_id,token_hash,csrf_hash,security_version,updated_at,last_seen_at,expires_at,ip,user_agent) VALUES ($1,$2,$3,$4,0,now(),now(),now()+$5*interval '1 day','127.0.0.1','test')",
        [uuidv7(), userId, tokenHash, 'b'.repeat(64), days],
      );
    await expect(insert(8)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(0)).rejects.toMatchObject({ code: '23514' });
    await insert(7);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    expect((await client.query('SELECT id FROM user_sessions')).rowCount).toBe(0);
    expect((await client.query('SELECT id FROM identity_tokens')).rowCount).toBe(0);
  });
});
