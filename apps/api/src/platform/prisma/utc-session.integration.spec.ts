import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Secret } from '@shipkeep/domain';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

import { applyMigrations } from '../../testing/apply-migrations';
import { POSTGRES_TEST_IMAGE } from '../../testing/postgres-image';
import { resetDatabase } from '../../testing/reset-database';
import { AppConfig } from '../config/app-config';
import type { ParsedConfig } from '../config/config.schema';
import { JobQueue } from '../jobs/job-queue';

import { PrismaClient } from './generated/client';
import { PrismaService } from './prisma.service';

// An instant the driver sends as text: a shift by the session offset shows in its epoch.
const INSTANT = new Date('2026-11-19T12:00:00.000Z');
const PARALLEL = 4;

interface SessionRow {
  zone: string;
  pid: number;
}

describe('database sessions on a server whose time zone is not UTC (#322)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let admin: Client;
  // A login whose default zone is UTC+2, as on a server configured for Rwanda.
  let kigaliRole = '';
  // A database whose login trigger moves every new session to UTC+2, after the connection is
  // set up: what a server-side hook can do to the API's connections.
  let forcedDatabase = '';
  let database = '';

  beforeAll(async () => {
    if (!process.env['DATABASE_URL'])
      container = await new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
    const url = container?.getConnectionUri() ?? process.env['DATABASE_URL'] ?? '';
    await resetDatabase(url);
    await applyMigrations(url, resolve(__dirname, '../../../prisma/migrations'));
    admin = new Client({ connectionString: url });
    await admin.connect();
    // Generated hexadecimal fixture password.
    const password = randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE shipkeep_tz_test LOGIN SUPERUSER PASSWORD '${password}'`);
    await admin.query(`ALTER ROLE shipkeep_tz_test SET timezone = 'Africa/Kigali'`);
    const role = new URL(url);
    role.username = 'shipkeep_tz_test';
    role.password = password;
    kigaliRole = role.toString();

    database = `shipkeep_tz_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${database}`);
    const inside = new URL(url);
    inside.pathname = `/${database}`;
    await applyMigrations(inside.toString(), resolve(__dirname, '../../../prisma/migrations'));
    const owner = new Client({ connectionString: inside.toString() });
    await owner.connect();
    try {
      await owner.query(`
        CREATE FUNCTION force_zone() RETURNS event_trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM set_config('TimeZone', 'Africa/Kigali', false); END $$`);
      await owner.query('CREATE EVENT TRIGGER force_zone ON login EXECUTE FUNCTION force_zone()');
    } finally {
      await owner.end();
    }
    forcedDatabase = inside.toString();
  });

  afterAll(async () => {
    if (database) await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query('DROP OWNED BY shipkeep_tz_test CASCADE');
    await admin.query('DROP ROLE IF EXISTS shipkeep_tz_test');
    await admin.end();
    await container?.stop();
  });

  const config = (url: string) =>
    new AppConfig(new ConfigService<ParsedConfig, true>({ DATABASE_URL: new Secret(url) }));

  it('shifts an instant written by the driver when the session is not in UTC', async () => {
    // The cause, without the fix: the adapter sends the Date without an offset, read in the
    // session zone.
    for (const url of [kigaliRole, forcedDatabase]) {
      const raw = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
      try {
        const rows = await raw.$queryRaw<{ zone: string; epoch: number }[]>`
          SELECT current_setting('TimeZone') AS zone, extract(epoch from ${INSTANT}::timestamptz)::float8 AS epoch`;
        expect(rows.at(0)?.zone).toBe('Africa/Kigali');
        expect(rows.at(0)?.epoch).not.toBe(INSTANT.getTime() / 1000);
      } finally {
        await raw.$disconnect();
      }
    }
  });

  it('runs every Prisma connection in UTC, so a written instant and now() agree', async () => {
    for (const url of [kigaliRole, forcedDatabase]) {
      const prisma = new PrismaService(config(url));
      await prisma.onModuleInit();
      try {
        const rows = await prisma.$queryRaw<{ epoch: number; skew: number }[]>`
          SELECT extract(epoch from ${INSTANT}::timestamptz)::float8 AS epoch,
                 abs(extract(epoch from (${new Date()}::timestamp - now()::timestamp)))::float8 AS skew`;
        expect(rows.at(0)?.epoch).toBe(INSTANT.getTime() / 1000);
        expect(rows.at(0)?.skew).toBeLessThan(5);
        // Several physical connections at once, each opened after the first: all in UTC.
        const sessions = await Promise.all(
          Array.from(
            { length: PARALLEL },
            () =>
              prisma.$queryRaw<SessionRow[]>`
                SELECT current_setting('TimeZone') AS zone, pg_backend_pid() AS pid, pg_sleep(0.3)::text`,
          ),
        );
        const rowsOfSessions = sessions.map((result) => result.at(0));
        expect(new Set(rowsOfSessions.map((row) => row?.pid)).size).toBeGreaterThan(1);
        expect(rowsOfSessions.map((row) => row?.zone)).toEqual(Array(PARALLEL).fill('UTC'));
      } finally {
        await prisma.$disconnect();
      }
    }
  });

  it('runs every job queue connection in UTC too', async () => {
    const queue = new JobQueue(config(forcedDatabase));
    await queue.onModuleInit();
    try {
      const results = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          queue
            .getDb()
            .executeSql(
              "SELECT current_setting('TimeZone') AS zone, pg_backend_pid() AS pid, pg_sleep(0.3)::text",
            ),
        ),
      );
      const rows = results.map((result) => result.rows.at(0) as SessionRow | undefined);
      expect(new Set(rows.map((row) => row?.pid)).size).toBeGreaterThan(1);
      expect(rows.map((row) => row?.zone)).toEqual(Array(PARALLEL).fill('UTC'));
    } finally {
      // stop() returns before the pool is closed; the database is dropped right after.
      const stopped = new Promise<void>((resolve) => {
        queue.once('stopped', () => {
          resolve();
        });
      });
      await queue.stop({ graceful: false, close: true });
      await stopped;
    }
  });
});
