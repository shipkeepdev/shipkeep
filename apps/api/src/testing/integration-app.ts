import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { INestApplication, InjectionToken } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

import { applyMigrations } from './apply-migrations';
import { resetDatabase } from './reset-database';

/** Integration files run serially and must only receive a disposable DATABASE_URL. */
export async function integrationApp(
  overrides: { token: InjectionToken; value: unknown }[] = [],
): Promise<{ app: INestApplication; databaseUrl: string; close: () => Promise<void> }> {
  const container = process.env['DATABASE_URL']
    ? undefined
    : await new PostgreSqlContainer('postgres:17').start();
  const directory = await mkdtemp(join(tmpdir(), 'shipkeep-identity-test-'));
  const previous = {
    DATABASE_URL: process.env['DATABASE_URL'],
    SHIPKEEP_KEK_FILE: process.env['SHIPKEEP_KEK_FILE'],
    LOG_LEVEL: process.env['LOG_LEVEL'],
  };
  const cleanup = async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await container?.stop();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const databaseUrl = previous.DATABASE_URL ?? container?.getConnectionUri() ?? '';
    process.env['DATABASE_URL'] = databaseUrl;
    process.env['SHIPKEEP_KEK_FILE'] = join(directory, 'kek');
    process.env['LOG_LEVEL'] = 'error';
    await writeFile(process.env['SHIPKEEP_KEK_FILE'], randomBytes(32), { mode: 0o400 });
    await resetDatabase(databaseUrl);
    await applyMigrations(databaseUrl, resolve(__dirname, '../../prisma/migrations'));
    const { AppModule } = await import('../app.module.js');
    const { configureApp } = await import('../bootstrap.js');
    let builder = Test.createTestingModule({ imports: [AppModule] });
    for (const { token, value } of overrides)
      builder = builder.overrideProvider(token).useValue(value);
    const module = await builder.compile();
    const app = configureApp(module.createNestApplication({ bufferLogs: true }));
    try {
      await app.init();
    } catch (error: unknown) {
      await app.close();
      throw error;
    }
    return {
      app,
      databaseUrl,
      close: async () => {
        try {
          await app.close();
        } finally {
          await cleanup();
        }
      },
    };
  } catch (error: unknown) {
    await cleanup();
    throw error;
  }
}
