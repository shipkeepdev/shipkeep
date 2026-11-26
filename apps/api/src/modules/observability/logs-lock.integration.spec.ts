import { Client } from 'pg';

import { tenantHttpFixture } from '../../testing/tenant-http';

import { LOGS_STORE, type LogsStore } from './application/ports';

/**
 * Issue #488, with the real HTTP pipeline and PostgreSQL: while the log store is slow to answer,
 * no transaction stays open and the account's lock is free, and access lost meanwhile returns
 * nothing.
 */
describe('log searches against a slow store', () => {
  let release: () => void = () => undefined;
  let reading: () => void = () => undefined;
  let read = new Promise<void>((resolve) => (reading = resolve));
  const store: LogsStore = {
    write: () => Promise.resolve(),
    query: () => {
      reading();
      return new Promise((resolve) => {
        release = () => {
          resolve([
            { _time: '2026-11-25T10:00:00Z', _msg: 'slow line', stream: 'stdout', instance: '0' },
          ]);
        };
      });
    },
  };
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let admin: Client;
  let logs: string;

  beforeAll(async () => {
    fixture = await tenantHttpFixture([{ token: LOGS_STORE, value: store }]);
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    const created = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'slow-logs',
          build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
          run: { port: 3000 },
        },
      })
      .expect(201);
    const from = encodeURIComponent('2026-11-25T09:00:00Z');
    const to = encodeURIComponent('2026-11-25T11:00:00Z');
    logs = `${fixture.environment}/applications/${(created.body as { id: string }).id}/logs?from=${from}&to=${to}`;
  });
  afterAll(async () => {
    await admin.end();
    await fixture.close();
  });

  /**
   * Starts a search and waits until the store is answering it. The answer comes in an object: an
   * async function would otherwise wait for it, which needs the store released first.
   */
  async function slowSearch(actor: 'owner' | 'environmentViewer') {
    read = new Promise<void>((resolve) => (reading = resolve));
    const pending = fixture.get(logs, actor).then((response) => response);
    // A search that never reaches the store fails here, with its answer, instead of waiting.
    const early = await Promise.race([read.then(() => undefined), pending]);
    if (early)
      throw new Error(
        `the search answered ${String(early.status)} before the store: ${JSON.stringify(early.body)}`,
      );
    return { pending };
  }

  it('holds no transaction and no account lock while the store answers', async () => {
    const { pending } = await slowSearch('owner');
    const waiting = await admin.query<{ count: string }>(
      "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'",
    );
    expect(waiting.rows[0]?.count).toBe('0');
    // Another command of the same account takes its lock and is not held up by the search.
    const project = await Promise.race([
      fixture
        .post(`/api/v1/organizations/${fixture.organizationId}/projects`, 'owner', {
          name: 'While searching',
          slug: 'while-searching',
        })
        .then((response) => response.status),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve('blocked');
        }, 5000);
      }),
    ]);
    expect(project).toBe(201);
    release();
    const answer = await pending;
    expect(answer.status).toBe(200);
    expect((answer.body as { lines: { line: string }[] }).lines.map((l) => l.line)).toEqual([
      'slow line',
    ]);
  });

  it('returns nothing to someone whose access ended while the store answered', async () => {
    const { pending } = await slowSearch('environmentViewer');
    await admin.query('DELETE FROM role_bindings WHERE membership_id = $1', [
      fixture.actors.environmentViewer.membershipId,
    ]);
    release();
    const answer = await pending;
    expect(answer.status).toBe(404);
    expect(JSON.stringify(answer.body)).not.toContain('slow line');
  });
});
