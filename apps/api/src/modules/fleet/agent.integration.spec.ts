import { randomBytes } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { applyMigrations } from '../../testing/apply-migrations';
import { fleetDatabase, type FleetDatabase } from '../../testing/fleet-database';
import { startGoAgent } from '../../testing/go-agent';
import { POSTGRES_TEST_IMAGE } from '../../testing/postgres-image';
import { resetDatabase } from '../../testing/reset-database';
import { IssueJoinToken } from './application/issue-join-token';
import { AgentGateway } from './interface/agent-gateway';

it('enrolls the real Go daemon, reconnects after API restart and rejects reuse/revocation', async () => {
  let app: INestApplication | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  let db: FleetDatabase | undefined;
  const previousUrl = process.env['DATABASE_URL'];
  const organizationId = '0192f0c0-0000-7000-8000-0000000000ad';
  const dir = await mkdtemp(join(tmpdir(), 'shipkeep-agent-integration-'));
  const abort = new AbortController();
  let child: Promise<void> | undefined;
  try {
    if (!previousUrl) container = await new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
    const adminUrl = container?.getConnectionUri() ?? previousUrl ?? '';
    await resetDatabase(adminUrl);
    await applyMigrations(adminUrl, resolve(__dirname, '../../../prisma/migrations'));
    // Both API instances run on the restricted login, under the fleet row security (ADR 0015).
    db = await fleetDatabase(adminUrl);
    await db.createOrganization(organizationId);
    process.env['DATABASE_URL'] = db.runtimeUrl;
    const kek = join(dir, 'kek');
    await writeFile(kek, randomBytes(32), { mode: 0o400 });
    process.env['SHIPKEEP_KEK_FILE'] = kek;
    process.env['LOG_LEVEL'] = 'error';
    process.env['AGENT_GATEWAY_ADDR'] = '127.0.0.1:0';
    process.env['AGENT_GATEWAY_SERVER_NAME'] = '127.0.0.1';
    const { createApp } = await import('../../bootstrap.js');
    app = await createApp();
    await app.init();
    await app.get(AgentGateway).start();
    const address = app.get(AgentGateway).address();
    if (!address || typeof address === 'string') throw new Error('missing gateway address');
    const token = await app.get(IssueJoinToken).execute({
      organizationId,
      actor: { kind: 'user', id: 'usr_test' },
    });
    const fixture = join(dir, 'fixture.json');
    await writeFile(
      fixture,
      JSON.stringify({
        address: `127.0.0.1:${String(address.port)}`,
        fingerprint: token.caFingerprint,
        token: token.value.expose(),
      }),
      { mode: 0o600 },
    );
    const goDone = startGoAgent(fixture, abort.signal);
    child = goDone;
    // Observe failures immediately, including while waiting for lifecycle markers.
    void child.catch(() => undefined);
    const marker = async (name: string) => {
      for (let attempt = 0; attempt < 600; attempt++) {
        try {
          await access(`${fixture}.${name}`);
          return;
        } catch {
          /* Agent has not reached this step. */
        }
        await Promise.race([
          delay(100),
          goDone.then(() => {
            throw new Error('agent ended before expected lifecycle marker');
          }),
        ]);
      }
      throw new Error('agent lifecycle marker timed out');
    };
    await marker('connected');
    await app.close();
    app = undefined;
    process.env['AGENT_GATEWAY_ADDR'] = `127.0.0.1:${String(address.port)}`;
    app = await createApp();
    // Both application instances share the loaded module in this process; keep the chosen port.
    app.get(ConfigService).set('AGENT_GATEWAY_ADDR', `127.0.0.1:${String(address.port)}`);
    await app.init();
    await app.get(AgentGateway).start();
    await marker('reconnected');
    await db.admin.query('UPDATE node_certificates SET revoked_at=now()');
    await child;
  } finally {
    abort.abort();
    await child?.catch(() => undefined);
    await app?.close();
    await db?.close();
    await container?.stop();
    if (previousUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env['DATABASE_URL'] = previousUrl;
    await rm(dir, { recursive: true, force: true });
  }
});
