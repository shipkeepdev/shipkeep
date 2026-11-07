import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { INestApplication, InjectionToken, NestApplicationOptions } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer } from '@testcontainers/postgresql';

import { applyMigrations } from './apply-migrations';
import { releaseAuditLog, useAuditLog } from './audit-log';
import { resetDatabase } from './reset-database';
import { runtimeDatabase } from './runtime-database';
import { POSTGRES_TEST_IMAGE } from './postgres-image';

/**
 * Integration files run serially and must only receive a disposable DATABASE_URL. One app per spec
 * file: configuration is read once per module graph, so a second app in a file would still look
 * for the first one's deleted KEK file.
 */
export async function integrationApp(
  overrides: { token: InjectionToken; value: unknown }[] = [],
  options: {
    isolatedDatabase?: boolean;
    restrictedDatabase?: boolean;
    httpsOptions?: NestApplicationOptions['httpsOptions'];
    beforeInit?: (app: INestApplication) => Promise<void>;
  } = {},
): Promise<{ app: INestApplication; databaseUrl: string; close: () => Promise<void> }> {
  const container =
    process.env['DATABASE_URL'] && !options.isolatedDatabase
      ? undefined
      : await new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
  const directory = await mkdtemp(join(tmpdir(), 'shipkeep-identity-test-'));
  const previous = {
    DATABASE_URL: process.env['DATABASE_URL'],
    SHIPKEEP_KEK_FILE: process.env['SHIPKEEP_KEK_FILE'],
    LOG_LEVEL: process.env['LOG_LEVEL'],
  };
  let closeRuntime: (() => Promise<void>) | undefined;
  const cleanup = async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    try {
      await releaseAuditLog();
      await closeRuntime?.();
    } finally {
      await container?.stop();
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const databaseUrl = container?.getConnectionUri() ?? previous.DATABASE_URL ?? '';
    process.env['DATABASE_URL'] = databaseUrl;
    process.env['SHIPKEEP_KEK_FILE'] = join(directory, 'kek');
    process.env['LOG_LEVEL'] = 'error';
    await writeFile(process.env['SHIPKEEP_KEK_FILE'], randomBytes(32), { mode: 0o400 });
    await resetDatabase(databaseUrl);
    await applyMigrations(databaseUrl, resolve(__dirname, '../../prisma/migrations'));
    useAuditLog(databaseUrl);
    if (options.restrictedDatabase) {
      const runtime = await runtimeDatabase(databaseUrl);
      closeRuntime = runtime.close;
      process.env['DATABASE_URL'] = runtime.url;
    }
    const { AppModule } = await import('../app.module.js');
    const { configureApp } = await import('../bootstrap.js');
    let builder = Test.createTestingModule({ imports: [AppModule] });
    for (const { token, value } of overrides)
      builder = builder.overrideProvider(token).useValue(value);
    const module = await builder.compile();
    const app = configureApp(
      module.createNestApplication({ bufferLogs: true, httpsOptions: options.httpsOptions }),
    );
    try {
      await options.beforeInit?.(app);
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
