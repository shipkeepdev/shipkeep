import { createHmac, randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { GITHUB_MANIFESTS, type GithubManifests } from './application/ports';
import { installationLockKey } from './infrastructure/prisma-github-webhook.store';

/** A key-shaped value that is no key, put together here so that no scanner reads the source as one. */
function fakePem(body: string): string {
  const armor = (edge: string, kind = 'PRIVATE') => `-----${edge} RSA ${kind} KEY-----`;
  return `${armor('BEGIN')}\n${body}\n${armor('END')}\n`;
}

/** Obviously fake values: no real key or secret has this shape. */
const PEM = fakePem('MIIEfakeKeyMaterialForShipkeepTests==');
const WEBHOOK = 'whsec_test_fake_webhook_secret';
const APP_ID = 515151;

/** ADR 0031: GitHub's deliveries over HTTP, signed as GitHub signs them, with PostgreSQL. */
describe('GitHub webhooks over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let admin: Client;
  const manifests: GithubManifests = {
    convert: () =>
      Promise.resolve({
        id: APP_ID,
        slug: 'shipkeep-hooks-a1b2c3',
        name: 'Shipkeep hooks a1b2c3',
        owner: { login: 'acme-corp' },
        client_id: 'Iv23liFakeHooks',
        client_secret: 'sk_test_fake_client_secret',
        webhook_secret: WEBHOOK,
        pem: PEM,
      }),
  };
  const hook = (organizationId = fixture.organizationId) =>
    `/api/v1/webhooks/github/${organizationId}`;
  const sign = (body: string, secret = WEBHOOK) =>
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const deliver = (
    event: string,
    payload: object,
    options: { delivery?: string; signature?: string; organizationId?: string } = {},
  ) => {
    const body = JSON.stringify(payload);
    return fixture
      .http()
      .post(hook(options.organizationId))
      .set('content-type', 'application/json')
      .set('x-github-event', event)
      .set('x-github-delivery', options.delivery ?? randomUUID())
      .set('x-hub-signature-256', options.signature ?? sign(body))
      .send(body);
  };
  /** GitHub's time of a change, `minutes` after a fixed start, so that each event is newer. */
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 25, 9, minutes)).toISOString();
  const installation = (
    action: string,
    minutes: number,
    options: { id?: number; selection?: string } = {},
  ) => ({
    action,
    installation: {
      id: options.id ?? 77,
      app_id: APP_ID,
      repository_selection: options.selection ?? 'selected',
      updated_at: at(minutes),
      account: { login: 'acme-corp', type: 'Organization' },
    },
    sender: { login: 'octocat' },
  });
  /** The installations in place: a removed one stays as a tombstone, counted apart. */
  const installations = async () =>
    (
      await admin.query<{
        installation_id: string;
        suspended_at: Date | null;
        repository_selection: string;
      }>(
        'SELECT installation_id, suspended_at, repository_selection FROM github_installations WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY installation_id',
        [fixture.organizationId],
      )
    ).rows;
  const row = async (id: number) =>
    (
      await admin.query<{
        suspended_at: Date | null;
        repository_selection: string;
        updated_at: Date;
        deleted_at: Date | null;
      }>(
        'SELECT suspended_at, repository_selection, updated_at, deleted_at FROM github_installations WHERE organization_id = $1 AND installation_id = $2',
        [fixture.organizationId, id],
      )
    ).rows.at(0);
  const audited = async (id: number) =>
    (
      await auditLog().findMany({
        where: { targetType: 'github_installation', targetId: String(id) },
        orderBy: { createdAt: 'asc' },
      })
    ).map((event) => event.action);
  /** Waits until `count` requests of this database wait for a lock. */
  const waiting = async (count: number) => {
    for (let tries = 0; tries < 200; tries++) {
      const waits = await admin.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if (Number(waits.rows[0]?.n) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`fewer than ${String(count)} requests wait for a lock`);
  };
  /** Holds the installation's row until `release`, so that deliveries meet at its write. */
  const holdRow = async (id: number) => {
    const holder = new Client({ connectionString: fixture.databaseUrl });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query(
      'SELECT 1 FROM github_installations WHERE organization_id = $1 AND installation_id = $2 FOR UPDATE',
      [fixture.organizationId, id],
    );
    return async () => {
      await holder.query('COMMIT');
      await holder.end();
    };
  };
  /** Starts a delivery now and returns its status once answered. */
  const started = (event: string, payload: object) =>
    deliver(event, payload).then((response) => response.status);

  beforeAll(async () => {
    fixture = await tenantHttpFixture([{ token: GITHUB_MANIFESTS, value: manifests }]);
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    // Before the App exists, nothing is accepted.
    await deliver('ping', { hook: { app_id: APP_ID } }).expect(401);
    const creation = await fixture
      .post(`${fixture.root}/github-app/manifests`, 'owner', { owner: 'user' })
      .expect(201);
    const state = new URL((creation.body as { url: string }).url).searchParams.get('state');
    await fixture.post(`${fixture.root}/github-app`, 'owner', { code: 'c', state }).expect(201);
  });
  afterAll(async () => {
    await admin.end();
    await fixture.close();
  });

  it('accepts only deliveries signed with the App secret, over their exact bytes', async () => {
    await deliver('ping', { hook: { app_id: APP_ID } }).expect(204);
    const body = JSON.stringify({ hook: { app_id: APP_ID } });
    for (const signature of [
      sign(body, 'another secret'),
      sign(`${body} `),
      'sha256=',
      `sha1=${'a'.repeat(40)}`,
    ])
      await deliver('ping', { hook: { app_id: APP_ID } }, { signature }).expect(401);
    // A ping of another App, signed with this one's secret, is not this App's.
    await deliver('ping', { hook: { app_id: APP_ID + 1 } }).expect(401);
    // The organization in the URL must be the App's: the other organization has none.
    await deliver(
      'ping',
      { hook: { app_id: APP_ID } },
      { organizationId: fixture.foreignId },
    ).expect(401);
    await deliver('ping', {}, { delivery: 'not-a-guid' }).expect(400);
    // Over 1 MiB, the body is refused unread.
    await fixture
      .http()
      .post(hook())
      .set('content-type', 'application/json')
      .send(`"${'x'.repeat(1 << 20)}"`)
      .expect(413);
  });

  it('records installations once per delivery and per body, newer changes only, audited', async () => {
    const delivery = randomUUID();
    await deliver('installation', installation('created', 1), { delivery }).expect(204);
    expect(await installations()).toEqual([
      { installation_id: '77', suspended_at: null, repository_selection: 'selected' },
    ]);
    // The same delivery again, or its signed body under a new identifier, does nothing.
    await deliver('installation', installation('created', 1), { delivery }).expect(204);
    await deliver('installation', installation('created', 1)).expect(204);
    await deliver('installation', installation('suspend', 2)).expect(204);
    expect((await installations())[0]?.suspended_at).toBeInstanceOf(Date);
    // An event older than the last one applied changes nothing, even signed and new.
    await deliver('installation', installation('unsuspend', 1, { selection: 'all' })).expect(204);
    expect((await installations())[0]?.suspended_at).toBeInstanceOf(Date);
    await deliver('installation', installation('unsuspend', 3)).expect(204);
    await deliver(
      'installation_repositories',
      installation('added', 4, { selection: 'all' }),
    ).expect(204);
    expect(await installations()).toEqual([
      { installation_id: '77', suspended_at: null, repository_selection: 'all' },
    ]);
    await deliver('installation', installation('deleted', 5)).expect(204);
    expect(await installations()).toEqual([]);
    expect((await row(77))?.deleted_at).toBeInstanceOf(Date);
    // A suspension of an installation whose creation was never received records it.
    await deliver('installation', installation('suspend', 6, { id: 79 })).expect(204);
    expect(await installations()).toEqual([
      {
        installation_id: '79',
        suspended_at: expect.any(Date) as Date,
        repository_selection: 'selected',
      },
    ]);
    // An installation of another App, even signed, is refused and recorded nowhere.
    const foreign = installation('created', 7, { id: 78 });
    foreign.installation.app_id = APP_ID + 1;
    const refused = randomUUID();
    await deliver('installation', foreign, { delivery: refused }).expect(400);
    const recorded = await admin.query<{ delivery_id: string }>(
      'SELECT delivery_id FROM github_deliveries WHERE delivery_id = $1',
      [refused],
    );
    expect(recorded.rows).toEqual([]);

    const events = await auditLog().findMany({
      where: { action: { startsWith: 'github.installation' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => event.action)).toEqual([
      'github.installation_added',
      'github.installation_suspended',
      'github.installation_unsuspended',
      'github.installation_repositories_changed',
      'github.installation_removed',
      'github.installation_suspended',
    ]);
    expect(events[0]?.metadata).toEqual({
      installationId: 77,
      accountLogin: 'acme-corp',
      accountType: 'Organization',
      repositorySelection: 'selected',
      githubSender: 'octocat',
    });
  });

  it('never brings a removed installation back, whatever comes later (#475)', async () => {
    await deliver('installation', installation('created', 10, { id: 81 })).expect(204);
    await deliver('installation', installation('deleted', 12, { id: 81 })).expect(204);
    // A delayed, distinct, signed delivery older than the removal, then newer ones: none applies.
    await deliver('installation', installation('unsuspend', 11, { id: 81 })).expect(204);
    await deliver(
      'installation_repositories',
      installation('added', 11, { id: 81, selection: 'all' }),
    ).expect(204);
    await deliver('installation', installation('created', 13, { id: 81 })).expect(204);
    await deliver('installation', installation('unsuspend', 14, { id: 81 })).expect(204);
    // The same removal again, under another identifier or body, does nothing more.
    await deliver('installation', installation('deleted', 12, { id: 81 })).expect(204);
    await deliver('installation', installation('deleted', 15, { id: 81 })).expect(204);
    // Nor once the deliveries recorded are forgotten.
    await admin.query('DELETE FROM github_deliveries WHERE organization_id = $1', [
      fixture.organizationId,
    ]);
    await deliver('installation', installation('unsuspend', 11, { id: 81 })).expect(204);
    expect((await row(81))?.deleted_at).toBeInstanceOf(Date);
    expect((await installations()).map((i) => i.installation_id)).not.toContain('81');
    expect(await audited(81)).toEqual(['github.installation_added', 'github.installation_removed']);
    // A removal whose installation was never received leaves a tombstone too: its delayed
    // creation brings nothing back.
    await deliver('installation', installation('deleted', 21, { id: 82 })).expect(204);
    await deliver('installation', installation('created', 20, { id: 82 })).expect(204);
    expect((await row(82))?.deleted_at).toBeInstanceOf(Date);
    expect(await audited(82)).toEqual(['github.installation_removed']);
  });

  it('keeps the more restrictive state at equal times', async () => {
    await deliver('installation', installation('created', 30, { id: 83 })).expect(204);
    // Suspended in the same second it was created: the suspension applies.
    await deliver('installation', installation('suspend', 30, { id: 83 })).expect(204);
    expect((await row(83))?.suspended_at).toBeInstanceOf(Date);
    // An unsuspension or a selection change at that same time does not undo it.
    await deliver('installation', installation('unsuspend', 30, { id: 83 })).expect(204);
    await deliver(
      'installation_repositories',
      installation('added', 30, { id: 83, selection: 'all' }),
    ).expect(204);
    expect(await row(83)).toMatchObject({ repository_selection: 'selected' });
    expect((await row(83))?.suspended_at).toBeInstanceOf(Date);
    expect(await audited(83)).toEqual([
      'github.installation_added',
      'github.installation_suspended',
    ]);
  });

  describe('two deliveries for one installation at once (#476)', () => {
    for (const order of ['newer first', 'older first'] as const) {
      it(`keeps the newer state, the ${order}`, async () => {
        const id = order === 'newer first' ? 84 : 85;
        await deliver('installation', installation('created', 40, { id })).expect(204);
        const release = await holdRow(id);
        const newer = installation('suspend', 42, { id });
        const older = installation('unsuspend', 41, { id });
        const [first, second] = order === 'newer first' ? [newer, older] : [older, newer];
        const answers = [started('installation', first)];
        await waiting(1);
        answers.push(started('installation', second));
        await waiting(2);
        await release();
        expect(await Promise.all(answers)).toEqual([204, 204]);
        const after = await row(id);
        expect(after?.suspended_at).toBeInstanceOf(Date);
        expect(after?.updated_at.toISOString()).toBe(
          installation('suspend', 42).installation.updated_at,
        );
        // A stale event that lost is not audited as applied after the newer one.
        const actions = await audited(id);
        expect(actions.at(-1)).toBe('github.installation_suspended');
      });
    }

    it('keeps a removal against a change at the same time', async () => {
      await deliver('installation', installation('created', 50, { id: 86 })).expect(204);
      const release = await holdRow(86);
      const answers = [started('installation', installation('deleted', 52, { id: 86 }))];
      await waiting(1);
      answers.push(
        started(
          'installation_repositories',
          installation('added', 52, { id: 86, selection: 'all' }),
        ),
      );
      await waiting(2);
      await release();
      expect(await Promise.all(answers)).toEqual([204, 204]);
      expect((await row(86))?.deleted_at).toBeInstanceOf(Date);
      expect(await audited(86)).toEqual([
        'github.installation_added',
        'github.installation_removed',
      ]);
    });

    it('records a first delivery once when two arrive together', async () => {
      const holder = new Client({ connectionString: fixture.databaseUrl });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1)', [
        installationLockKey(fixture.organizationId, 87).toString(),
      ]);
      const answers = [
        started('installation', installation('created', 60, { id: 87 })),
        started(
          'installation_repositories',
          installation('added', 61, { id: 87, selection: 'all' }),
        ),
      ];
      await waiting(2);
      await holder.query('COMMIT');
      await holder.end();
      expect(await Promise.all(answers)).toEqual([204, 204]);
      expect(await row(87)).toMatchObject({ repository_selection: 'all', deleted_at: null });
    });

    it('never waits for another installation, even while expired records are removed', async () => {
      // Expired records: the delivery that removes them keeps them locked while it waits.
      for (const minute of [1, 2, 3])
        await deliver('push', { ref: 'refs/heads/main', after: String(minute).repeat(40) }).expect(
          204,
        );
      await admin.query(
        "UPDATE github_deliveries SET received_at = now() - interval '31 days' WHERE organization_id = $1 AND event = 'push'",
        [fixture.organizationId],
      );
      const holder = new Client({ connectionString: fixture.databaseUrl });
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1)', [
        installationLockKey(fixture.organizationId, 88).toString(),
      ]);
      // This one removes the expired records, then waits for installation 88.
      const blocked = started('installation', installation('created', 70, { id: 88 }));
      await waiting(1);
      try {
        await deliver('installation', installation('created', 70, { id: 89 })).expect(204);
        await deliver('ping', { hook: { app_id: APP_ID } }).expect(204);
        expect(await row(89)).toMatchObject({ deleted_at: null });
      } finally {
        await holder.query('COMMIT');
        await holder.end();
      }
      expect(await blocked).toBe(204);
      expect(await row(88)).toMatchObject({ deleted_at: null });
    });
  });

  it('keeps a delivery identifier 30 days, then forgets it', async () => {
    const old = randomUUID();
    await deliver(
      'push',
      { ref: 'refs/heads/main', after: 'a'.repeat(40) },
      { delivery: old },
    ).expect(204);
    await admin.query(
      "UPDATE github_deliveries SET received_at = now() - interval '31 days' WHERE delivery_id = $1",
      [old],
    );
    await deliver('push', { ref: 'refs/heads/main', after: 'b'.repeat(40) }).expect(204);
    const kept = await admin.query('SELECT 1 FROM github_deliveries WHERE delivery_id = $1', [old]);
    expect(kept.rows).toEqual([]);
  });
});
