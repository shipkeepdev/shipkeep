import { Client } from 'pg';

import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { GITHUB_MANIFESTS, type GithubManifests } from './application/ports';

/** A key-shaped value that is no key, put together here so that no scanner reads the source as one. */
function fakePem(body: string): string {
  const armor = (edge: string, kind = 'PRIVATE') => `-----${edge} RSA ${kind} KEY-----`;
  return `${armor('BEGIN')}\n${body}\n${armor('END')}\n`;
}

/** Obviously fake values: no real key or secret has this shape. */
const PEM = fakePem('MIIEfakeKeyMaterialForShipkeepTests==');
const WEBHOOK = 'whsec_test_fake_webhook_secret';
const CLIENT = 'sk_test_fake_client_secret';

interface Creation {
  url: string;
  manifest: string;
}

/** ADR 0031: the manifest flow over HTTP, with PostgreSQL, the runtime role and a fake GitHub. */
describe('the GitHub App manifest flow over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let admin: Client;
  const codes: string[] = [];
  const answer = {
    id: 424242,
    slug: 'shipkeep-tenant-a1b2c3',
    name: 'Shipkeep tenant a1b2c3',
    owner: { login: 'acme-corp' },
    client_id: 'Iv23liFakeClient',
    client_secret: CLIENT,
    webhook_secret: WEBHOOK,
    pem: PEM,
  };
  let answered: object = answer;
  /** Runs while GitHub "answers", before the answer comes back. */
  let meanwhile: (() => Promise<void>) | undefined;
  const manifests: GithubManifests = {
    convert: async (code) => {
      codes.push(code);
      await meanwhile?.();
      return answered;
    },
  };
  const app = () => `${fixture.root}/github-app`;
  const start = (body: object = { owner: 'user' }) =>
    fixture.post(`${app()}/manifests`, 'owner', body).expect(201);
  const stateOf = (creation: Creation) => new URL(creation.url).searchParams.get('state') ?? '';

  beforeAll(async () => {
    fixture = await tenantHttpFixture([{ token: GITHUB_MANIFESTS, value: manifests }]);
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
  });
  afterAll(async () => {
    await admin.end();
    await fixture.close();
  });

  it('lets an owner only start the flow, with the manifest of ADR 0031', async () => {
    for (const actor of ['admin', 'member', 'projectAdmin', 'outsider'] as const)
      await fixture.post(`${app()}/manifests`, actor, { owner: 'user' }).expect(404);

    const personal = (await start()).body as Creation;
    expect(personal.url).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=[\w-]{43}$/);
    const manifest = JSON.parse(personal.manifest) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      public: false,
      default_events: ['push'],
      default_permissions: {
        metadata: 'read',
        contents: 'write',
        pull_requests: 'write',
        statuses: 'write',
      },
    });
    expect(String(manifest['name']).length).toBeLessThanOrEqual(34);
    expect((manifest['hook_attributes'] as { url: string }).url).toMatch(
      new RegExp(`/api/v1/webhooks/github/${fixture.organizationId}$`),
    );

    const onOrganization = (await start({ owner: 'organization', githubOrganization: 'acme-corp' }))
      .body as Creation;
    expect(onOrganization.url).toMatch(
      /^https:\/\/github\.com\/organizations\/acme-corp\/settings\/apps\/new\?state=/,
    );
    for (const body of [
      {},
      { owner: 'organization' },
      { owner: 'someone' },
      { owner: 'organization', githubOrganization: 'acme/../evil' },
    ])
      await fixture.post(`${app()}/manifests`, 'owner', body).expect(400);

    // The state is kept hashed only.
    const flows = await admin.query<{ state_hash: Buffer }>(
      'SELECT state_hash FROM github_app_flows WHERE organization_id = $1',
      [fixture.organizationId],
    );
    expect(flows.rows).toHaveLength(1);
    expect(flows.rows[0]?.state_hash.toString('utf8')).not.toContain(stateOf(onOrganization));
  });

  it('names the App to delete on GitHub when GitHub created one this installation cannot keep', async () => {
    const creation = (await start()).body as Creation;
    answered = { ...answer, pem: 'not a key' };
    const refused = await fixture
      .post(app(), 'owner', { code: 'code-0', state: stateOf(creation) })
      .expect(409);
    answered = answer;
    expect(refused.body).toMatchObject({ code: 'github_app_not_connected' });
    expect(JSON.stringify(refused.body)).toContain(
      'https://github.com/apps/shipkeep-tenant-a1b2c3',
    );
    expect(JSON.stringify(refused.body)).not.toMatch(/whsec|sk_test/);
    codes.length = 0;
  });

  it('refuses a flow that expires while GitHub answers', async () => {
    const creation = (await start()).body as Creation;
    meanwhile = async () => {
      // Valid when the request began, expired once GitHub has answered.
      await admin.query(
        "UPDATE github_app_flows SET expires_at = now() + interval '200 milliseconds' WHERE organization_id = $1",
        [fixture.organizationId],
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
    };
    const refused = await fixture
      .post(app(), 'owner', { code: 'code-late', state: stateOf(creation) })
      .expect(409);
    meanwhile = undefined;
    expect(refused.body).toMatchObject({ code: 'github_app_not_connected' });
    codes.length = 0;
  });

  it('completes only the latest flow of the owner who started it, before it expires', async () => {
    const creation = (await start()).body as Creation;
    const state = stateOf(creation);
    const complete = (body: object, actor: 'owner' | 'admin' = 'owner') =>
      fixture.post(app(), actor, body);

    // A state that is not the flow's, or an admin, never reaches GitHub.
    await complete({ code: 'code-1', state: 'b'.repeat(43) }).expect(400);
    await complete({ code: 'code-1', state }, 'admin').expect(404);
    // Someone else's flow, then an expired one.
    await admin.query('UPDATE github_app_flows SET user_id = $1 WHERE organization_id = $2', [
      fixture.actors.admin.id,
      fixture.organizationId,
    ]);
    await complete({ code: 'code-1', state }).expect(400);
    await admin.query(
      "UPDATE github_app_flows SET user_id = $1, expires_at = now() - interval '1 second' WHERE organization_id = $2",
      [fixture.actors.owner.id, fixture.organizationId],
    );
    await complete({ code: 'code-1', state }).expect(400);
    expect(codes).toEqual([]);

    await admin.query(
      "UPDATE github_app_flows SET expires_at = now() + interval '1 hour' WHERE organization_id = $1",
      [fixture.organizationId],
    );
    const created = await complete({ code: 'code-1', state }).expect(201);
    expect(created.body).toEqual({
      appId: 424242,
      slug: 'shipkeep-tenant-a1b2c3',
      name: 'Shipkeep tenant a1b2c3',
      ownerLogin: 'acme-corp',
      url: 'https://github.com/apps/shipkeep-tenant-a1b2c3',
      createdAt: expect.any(String) as string,
    });
    expect(codes).toEqual(['code-1']);

    // The flow is over: the same state again is refused, and so is a new flow.
    await complete({ code: 'code-2', state }).expect(409);
    await fixture.post(`${app()}/manifests`, 'owner', { owner: 'user' }).expect(409);
    expect(codes).toEqual(['code-1']);

    const shown = await fixture.get(app(), 'member').expect(200);
    expect(shown.body).toMatchObject({ app: { appId: 424242, ownerLogin: 'acme-corp' } });
    expect(JSON.stringify(shown.body)).not.toMatch(/PRIVATE KEY|whsec|sk_test/);
  });

  it('keeps the App secrets encrypted, bound to the App, and out of the audit log', async () => {
    const rows = await admin.query<{
      private_key_enc: Buffer;
      webhook_secret_enc: Buffer;
      client_secret_enc: Buffer;
    }>(
      'SELECT private_key_enc, webhook_secret_enc, client_secret_enc FROM github_apps WHERE organization_id = $1',
      [fixture.organizationId],
    );
    expect(rows.rows).toHaveLength(1);
    // The query types its rows as present; the length check above makes it so.
    const [row] = rows.rows;
    for (const [stored, plain] of [
      [row.private_key_enc, 'PRIVATE KEY'],
      [row.webhook_secret_enc, WEBHOOK],
      [row.client_secret_enc, CLIENT],
    ] as const)
      expect(stored.includes(Buffer.from(plain))).toBe(false);

    // Another organization of the same owner has no App: rows stay with their organization.
    const foreign = await fixture
      .get(`/api/v1/organizations/${fixture.foreignId}/github-app`, 'owner')
      .expect(200);
    expect(foreign.body).toEqual({ app: null });

    const events = await auditLog().findMany({
      where: { action: { startsWith: 'github.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => event.action)).toEqual([
      'github.app_flow_started',
      'github.app_flow_started',
      'github.app_flow_started',
      'github.app_flow_started',
      'github.app_flow_started',
      'github.app_created',
    ]);
    expect(events.at(-1)?.metadata).toEqual({
      appId: 424242,
      slug: 'shipkeep-tenant-a1b2c3',
      name: 'Shipkeep tenant a1b2c3',
      ownerLogin: 'acme-corp',
    });
    const everything = JSON.stringify(await auditLog().findMany({}));
    expect(everything).not.toMatch(/PRIVATE KEY|whsec_test|sk_test_fake_client/);
  });
});
