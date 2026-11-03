import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { createEvent, SYSTEM_ACTOR } from '@shipkeep/domain';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import request from 'supertest';

import { EnvelopeService } from '../../platform/crypto/envelope.service';
import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { applyMigrations } from '../../testing/apply-migrations';

// End to end through the real stack: a domain event published on the bus must land as an
// audit row, and envelope encryption must persist and reuse its data keys (PLAN M2.1b).
describe('audit log and envelope encryption against PostgreSQL', () => {
  let app: INestApplication | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl: string;

  beforeAll(async () => {
    if (!process.env['DATABASE_URL']) {
      container = await new PostgreSqlContainer('postgres:17').start();
      process.env['DATABASE_URL'] = container.getConnectionUri();
    }
    databaseUrl = process.env['DATABASE_URL'];
    await applyMigrations(databaseUrl, resolve(__dirname, '../../../prisma/migrations'));

    // A throwaway KEK: integration tests must never read the development one.
    const kekPath = join(await mkdtemp(join(tmpdir(), 'shipkeep-it-')), 'kek');
    await writeFile(kekPath, randomBytes(32), { mode: 0o400 });
    process.env['SHIPKEEP_KEK_FILE'] = kekPath;
    process.env['LOG_LEVEL'] = 'error';

    // The configuration module validates the environment at import time, so the application
    // module is loaded only once DATABASE_URL and the KEK are known.
    const bootstrap = await import('../../bootstrap.js');
    const created = await bootstrap.createApp();
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

  it('records every published domain event as an append-only audit row', async () => {
    if (!app) throw new Error('application did not start');
    const bus = app.get(DomainEventBus);
    const prisma = app.get(PrismaService);
    const orgId = '0192f0c0-0000-7000-8000-0000000000aa';

    await bus.publish([
      createEvent({
        type: 'node.enrolled',
        actor: { kind: 'user', id: 'usr_1', ip: '203.0.113.9' },
        target: { type: 'node', id: 'node_1' },
        organizationId: orgId,
        payload: { name: 'edge-1' },
      }),
      createEvent({
        type: 'control_plane.started',
        actor: SYSTEM_ACTOR,
        target: { type: 'control_plane', id: 'self' },
        payload: {},
      }),
    ]);

    const rows = await prisma.auditEvent.findMany({ orderBy: { id: 'asc' } });
    expect(rows.map((r: { action: string }) => r.action)).toEqual([
      'node.enrolled',
      'control_plane.started',
    ]);
    expect(rows[0]).toMatchObject({
      organizationId: orgId,
      actorKind: 'user',
      actorId: 'usr_1',
      ip: '203.0.113.9',
      targetType: 'node',
      targetId: 'node_1',
      metadata: { name: 'edge-1' },
    });
    expect(rows[1]).toMatchObject({ organizationId: null, actorKind: 'system', actorId: null });
  });

  it('persists wrapped data keys and round-trips values through the database', async () => {
    if (!app) throw new Error('application did not start');
    const envelope = app.get(EnvelopeService);
    const value = Buffer.from('postgresql://app:hunter2@db/app');

    const blob = await envelope.encryptFor('environment:env_1', 'secret:DATABASE_URL', value);
    expect(await envelope.decryptFor('environment:env_1', 'secret:DATABASE_URL', blob)).toEqual(
      value,
    );

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const keys = await client.query<{ scope: string; wrapped_key: Buffer; kek_version: number }>(
        "SELECT scope, wrapped_key, kek_version FROM data_encryption_keys WHERE scope LIKE 'environment:%'",
      );
      expect(keys.rows).toHaveLength(1);
      expect(keys.rows[0]?.scope).toBe('environment:env_1');
      expect(keys.rows[0]?.kek_version).toBe(1);
      // Neither the plaintext nor the unwrapped key is stored anywhere.
      const dump = await client.query<{ txt: string }>(
        "SELECT encode(wrapped_key, 'escape') AS txt FROM data_encryption_keys WHERE scope = 'environment:env_1'",
      );
      expect(dump.rows[0]?.txt).not.toContain('hunter2');
    } finally {
      await client.end();
    }
  });
});
