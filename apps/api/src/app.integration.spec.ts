import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';

import { createApp } from './bootstrap';

// Real PostgreSQL through Testcontainers (CLAUDE.md, tests: never mock Postgres in integration tests).
// CI provides DATABASE_URL from its service container; locally a container is started on demand.
describe('control plane against PostgreSQL', () => {
  let app: INestApplication | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    if (!process.env['DATABASE_URL']) {
      container = await new PostgreSqlContainer('postgres:17').start();
      process.env['DATABASE_URL'] = container.getConnectionUri();
    }
    process.env['SHIPKEEP_KEK_FILE'] ??= './deploy/dev/secrets/kek';
    const created = await createApp();
    await created.init();
    app = created;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('GET /api/v1/ready confirms the database connection', async () => {
    if (!app) throw new Error('application did not start');
    const res = await request(app.getHttpServer() as Server)
      .get('/api/v1/ready')
      .expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });
});
