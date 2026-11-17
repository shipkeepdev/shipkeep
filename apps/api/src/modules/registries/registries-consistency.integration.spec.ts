import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { MAX_REGISTRIES } from './domain/registry-credential';
import { registryLockKey } from './infrastructure/prisma-registry-credential.store';

/** Obviously fake: no real token has this shape. */
const PASSWORD = 'sk_test_fake_registry_password_race';

interface Stored {
  id: string;
  server: string;
  version: number;
}

/** ADR 0019: what two administrators see when they change the same credentials at once. */
describe('registry credentials changed concurrently', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let admin: Client;
  let holder: Client;
  const path = () => `${fixture.root}/registries`;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    admin = new Client({ connectionString: fixture.databaseUrl });
    holder = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    await holder.connect();
  });
  afterEach(async () => {
    // A test that failed while it held a lock must not keep it for the next one.
    await holder.query('ROLLBACK');
  });
  afterAll(async () => {
    await holder.end();
    await admin.end();
    await fixture.close();
  });

  const store = async (server: string): Promise<Stored> =>
    (
      await fixture
        .post(path(), 'owner', { server, username: 'deploy-bot', password: PASSWORD })
        .expect(200)
    ).body as Stored;
  /** Waits until this many statements of this database wait for what the holder locked. */
  async function waiting(count: number, statement = '%registry_credentials%'): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { rows } = await admin.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`,
        [statement],
      );
      if ((rows[0]?.waiting ?? 0) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`fewer than ${String(count)} statements wait`);
  }
  const removals = (id: string) =>
    auditLog().count({ where: { action: 'registry.credentials_removed', targetId: id } });

  it('removes credentials once when two administrators remove them together', async () => {
    const stored = await store('ghcr.io');
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM registry_credentials WHERE id = $1 FOR UPDATE', [stored.id]);
    // Both requests read the row, then wait for it.
    const both = [
      fixture.post(`${path()}/${stored.id}/remove`, 'owner', {}).then((response) => response),
      fixture.post(`${path()}/${stored.id}/remove`, 'admin', {}).then((response) => response),
    ];
    await waiting(2);
    await holder.query('COMMIT');
    const answers = await Promise.all(both);

    expect(answers.map((answer) => answer.status).sort()).toEqual([204, 409]);
    expect(answers.find((answer) => answer.status === 409)?.body).toMatchObject({
      code: 'registry_credentials_changed',
    });
    // One removal happened, and one is recorded.
    expect(await removals(stored.id)).toBe(1);
  });

  it('keeps credentials that were replaced while their removal waited', async () => {
    const stored = await store('quay.io');
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM registry_credentials WHERE id = $1 FOR UPDATE', [stored.id]);
    const removal = fixture
      .post(`${path()}/${stored.id}/remove`, 'owner', {})
      .then((response) => response);
    await waiting(1);
    // What a replacement commits: the next version of the same row.
    await holder.query('UPDATE registry_credentials SET version = version + 1 WHERE id = $1', [
      stored.id,
    ]);
    await holder.query('COMMIT');

    const answer = await removal;
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: 'registry_credentials_changed' });
    const kept = await admin.query<{ version: number }>(
      'SELECT version FROM registry_credentials WHERE id = $1',
      [stored.id],
    );
    expect(kept.rows).toEqual([{ version: 2 }]);
    expect(await removals(stored.id)).toBe(0);
  });

  const storedCount = async () =>
    (
      await admin.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM registry_credentials WHERE organization_id = $1',
        [fixture.organizationId],
      )
    ).rows[0]?.count ?? 0;
  /** Fills the organization up to this many registries, behind the API: these rows are never decrypted. */
  async function fillTo(total: number): Promise<void> {
    const missing = total - (await storedCount());
    for (let index = 0; index < missing; index++)
      await admin.query(
        `INSERT INTO registry_credentials
           (id, organization_id, server, username, password_enc, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'filler', '\\x00', 1, now(), now())`,
        [uuidv7(), fixture.organizationId, `filler-${uuidv7()}.example.com`],
      );
  }

  it('gives the last place to one of two administrators who add a registry together', async () => {
    await fillTo(MAX_REGISTRIES - 1);
    // Both additions wait for the lock that serializes them, then run one after the other.
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1)', [
      registryLockKey(fixture.organizationId).toString(),
    ]);
    const add = (actor: 'owner' | 'admin', server: string) =>
      fixture
        .post(path(), actor, { server, username: 'deploy-bot', password: PASSWORD })
        .then((response) => response);
    const both = [add('owner', 'last-a.example.com'), add('admin', 'last-b.example.com')];
    await waiting(2, '%pg_advisory_xact_lock%');
    await holder.query('COMMIT');
    const answers = await Promise.all(both);

    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect(answers.find((answer) => answer.status === 409)?.body).toMatchObject({
      code: 'registry_limit_reached',
    });
    expect(await storedCount()).toBe(MAX_REGISTRIES);
    const listed = await fixture.get(path(), 'owner').expect(200);
    expect((listed.body as { items: Stored[] }).items).toHaveLength(MAX_REGISTRIES);
  });

  it('lists every registry it accepted, and accepts no more than it lists', async () => {
    await fillTo(MAX_REGISTRIES);

    const listed = await fixture.get(path(), 'owner').expect(200);
    expect((listed.body as { items: Stored[] }).items).toHaveLength(MAX_REGISTRIES);
    await fixture
      .post(path(), 'owner', {
        server: 'one-too-many.example.com',
        username: 'deploy-bot',
        password: PASSWORD,
      })
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'registry_limit_reached' });
      });
    // Replacing one of them is not one more.
    await fixture
      .post(path(), 'owner', {
        server: 'quay.io',
        username: 'release-bot',
        password: PASSWORD,
      })
      .expect(200);
    const after = await fixture.get(path(), 'owner').expect(200);
    expect((after.body as { items: Stored[] }).items).toHaveLength(MAX_REGISTRIES);
  });
});
