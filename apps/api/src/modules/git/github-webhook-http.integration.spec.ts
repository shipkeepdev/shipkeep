import { createHmac, randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { GITHUB_MANIFESTS, type GithubManifests } from './application/ports';

/** Obviously fake values: no real key or secret has this shape. */
const PEM =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEfakeKeyMaterialForShipkeepTests==\n-----END RSA PRIVATE KEY-----\n';
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
  const installation = (action: string, id = 77) => ({
    action,
    installation: {
      id,
      app_id: APP_ID,
      repository_selection: 'selected',
      account: { login: 'acme-corp', type: 'Organization' },
    },
    sender: { login: 'octocat' },
  });
  const installations = async () =>
    (
      await admin.query<{ installation_id: string; suspended_at: Date | null }>(
        'SELECT installation_id, suspended_at FROM github_installations WHERE organization_id = $1',
        [fixture.organizationId],
      )
    ).rows;

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

  it('records installations once per delivery, and audits each change', async () => {
    const delivery = randomUUID();
    await deliver('installation', installation('created'), { delivery }).expect(204);
    expect(await installations()).toEqual([{ installation_id: '77', suspended_at: null }]);
    // The same delivery again does nothing; a suspension and its end change the row.
    await deliver('installation', installation('created'), { delivery }).expect(204);
    await deliver('installation', installation('suspend')).expect(204);
    expect((await installations())[0]?.suspended_at).toBeInstanceOf(Date);
    await deliver('installation', installation('unsuspend')).expect(204);
    await deliver('installation', installation('deleted')).expect(204);
    expect(await installations()).toEqual([]);
    // An installation of another App, even signed, is refused and recorded nowhere.
    const foreign = installation('created', 78);
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
      'github.installation_removed',
    ]);
    expect(events[0]?.metadata).toEqual({
      installationId: 77,
      accountLogin: 'acme-corp',
      accountType: 'Organization',
      repositorySelection: 'selected',
      githubSender: 'octocat',
    });
  });

  it('keeps a delivery identifier 30 days, then forgets it', async () => {
    const old = randomUUID();
    await deliver('push', { ref: 'refs/heads/main' }, { delivery: old }).expect(204);
    await admin.query(
      "UPDATE github_deliveries SET received_at = now() - interval '31 days' WHERE delivery_id = $1",
      [old],
    );
    await deliver('push', { ref: 'refs/heads/main' }).expect(204);
    const kept = await admin.query('SELECT 1 FROM github_deliveries WHERE delivery_id = $1', [old]);
    expect(kept.rows).toEqual([]);
  });
});
