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
import { NonUtcSessionError } from './utc-session';

// An instant the driver sends as text: a shift by the session offset shows in its epoch.
const INSTANT = new Date('2026-11-19T12:00:00.000Z');

describe('database sessions on a server whose time zone is not UTC (#322)', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let admin: Client;
  let kigali: string;
  let adminUrl: string;

  beforeAll(async () => {
    if (!process.env['DATABASE_URL'])
      container = await new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
    const url = container?.getConnectionUri() ?? process.env['DATABASE_URL'] ?? '';
    adminUrl = url;
    await resetDatabase(url);
    await applyMigrations(url, resolve(__dirname, '../../../prisma/migrations'));
    admin = new Client({ connectionString: url });
    await admin.connect();
    // A login whose default zone is UTC+2, as on a server configured for Rwanda. Generated
    // hexadecimal fixture password.
    const password = randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE shipkeep_tz_test LOGIN SUPERUSER PASSWORD '${password}'`);
    await admin.query(`ALTER ROLE shipkeep_tz_test SET timezone = 'Africa/Kigali'`);
    const login = new URL(url);
    login.username = 'shipkeep_tz_test';
    login.password = password;
    kigali = login.toString();
  });

  afterAll(async () => {
    await admin?.query('DROP OWNED BY shipkeep_tz_test CASCADE');
    await admin?.query('DROP ROLE IF EXISTS shipkeep_tz_test');
    await admin?.end();
    await container?.stop();
  });

  const config = (url: string) =>
    new AppConfig(new ConfigService<ParsedConfig, true>({ DATABASE_URL: new Secret(url) }));

  it('shifts an instant written by the driver when the session is not in UTC', async () => {
    // The cause, without the fix: the adapter sends the Date without an offset, read in the
    // session zone.
    const raw = new PrismaClient({ adapter: new PrismaPg({ connectionString: kigali }) });
    try {
      const [row] = await raw.$queryRaw<{ zone: string; epoch: number }[]>`
        SELECT current_setting('TimeZone') AS zone, extract(epoch from ${INSTANT}::timestamptz)::float8 AS epoch`;
      expect(row?.zone).toBe('Africa/Kigali');
      expect(row?.epoch).not.toBe(INSTANT.getTime() / 1000);
    } finally {
      await raw.$disconnect();
    }
  });

  it('runs every Prisma session in UTC, so a written instant and now() agree', async () => {
    const prisma = new PrismaService(config(kigali));
    await prisma.onModuleInit();
    try {
      const [row] = await prisma.$queryRaw<{ zone: string; epoch: number; skew: number }[]>`
        SELECT current_setting('TimeZone') AS zone,
               extract(epoch from ${INSTANT}::timestamptz)::float8 AS epoch,
               abs(extract(epoch from (${new Date()}::timestamp - now()::timestamp)))::float8 AS skew`;
      expect(row?.zone).toBe('UTC');
      expect(row?.epoch).toBe(INSTANT.getTime() / 1000);
      // A Date written now and PostgreSQL's now() are the same instant, seconds apart at most.
      expect(row?.skew).toBeLessThan(5);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('runs the job queue sessions in UTC too', async () => {
    const queue = new JobQueue(config(kigali));
    await queue.start();
    try {
      const { rows } = await queue.getDb().executeSql(`SELECT current_setting('TimeZone') AS zone`);
      expect(rows[0]?.zone).toBe('UTC');
    } finally {
      await queue.stop({ graceful: false, wait: true });
    }
  });

  it('refuses to start when the session is not in UTC after all', async () => {
    // Something between the API and PostgreSQL can undo the startup parameter (a pooler that
    // drops it). Reproduced with a login trigger that sets another zone once the session is open,
    // in a database of its own (event triggers belong to one database).
    const database = `shipkeep_tz_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(kigali);
    url.pathname = `/${database}`;
    const adminInside = new URL(adminUrl);
    adminInside.pathname = `/${database}`;
    const inside = new Client({ connectionString: adminInside.toString() });
    await inside.connect();
    try {
      await inside.query(`
        CREATE FUNCTION force_zone() RETURNS event_trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM set_config('TimeZone', 'Africa/Kigali', false); END $$`);
      await inside.query('CREATE EVENT TRIGGER force_zone ON login EXECUTE FUNCTION force_zone()');
      const prisma = new PrismaService(config(url.toString()));
      try {
        await expect(prisma.onModuleInit()).rejects.toThrow(NonUtcSessionError);
      } finally {
        await prisma.$disconnect();
      }
    } finally {
      await inside.end();
      await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    }
  });
});
