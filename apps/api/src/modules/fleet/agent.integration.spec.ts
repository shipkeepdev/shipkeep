import { randomBytes } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { startGoAgent } from '../../testing/go-agent';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { applyMigrations } from '../../testing/apply-migrations';
import { resetDatabase } from '../../testing/reset-database';
import { IssueJoinToken } from './application/issue-join-token';
import { AgentGateway } from './interface/agent-gateway';

it('enrolls the real Go daemon, reconnects after API restart and rejects reuse/revocation', async () => {
  let app: INestApplication | undefined;
  let container: StartedPostgreSqlContainer | undefined;
  const dir = await mkdtemp(join(tmpdir(), 'shipkeep-agent-integration-'));
  const abort = new AbortController();
  let child: Promise<void> | undefined;
  try {
    if (!process.env['DATABASE_URL']) {
      container = await new PostgreSqlContainer('postgres:17').start();
      process.env['DATABASE_URL'] = container.getConnectionUri();
    }
    await resetDatabase(process.env['DATABASE_URL']);
    await applyMigrations(
      process.env['DATABASE_URL'],
      resolve(__dirname, '../../../prisma/migrations'),
    );
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
      organizationId: '0192f0c0-0000-7000-8000-0000000000ad',
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
    await app.get(PrismaService).nodeCertificate.updateMany({ data: { revokedAt: new Date() } });
    await child;
  } finally {
    abort.abort();
    await child?.catch(() => undefined);
    await app?.close();
    await container?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
