import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';

const config = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  name: 'billing-api',
  build: { type: 'image', image: 'ghcr.io/acme/billing:1.4.2' },
  run: { port: 3000 },
  secrets: ['DATABASE_URL'],
  ...overrides,
});

interface ApplicationBody {
  id: string;
  name: string;
  configSha: string;
  config: Record<string, unknown>;
}

/** PLAN M3.4b1: image applications defined through the API. */
describe('applications over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  const path = () => `${fixture.environment}/applications`;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('creates, reads and updates an image application with optimistic concurrency', async () => {
    const created = (
      await fixture.post(path(), 'environmentAdmin', { config: config() }).expect(201)
    ).body as ApplicationBody;
    expect(created).toMatchObject({ name: 'billing-api', source: 'image' });
    expect(created.configSha).toMatch(/^[0-9a-f]{64}$/);
    await fixture
      .post(path(), 'owner', { config: config() })
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'application_name_taken' });
      });

    const listed = await fixture.get(path(), 'environmentViewer').expect(200);
    expect(listed.body).toEqual({ items: [expect.objectContaining({ id: created.id })] });
    await fixture.get(`${path()}/${created.id}`, 'environmentViewer').expect(200);

    const update = (expectedConfigSha: string, next = config({ run: { port: 8080 } })) =>
      fixture.post(`${path()}/${created.id}/config`, 'owner', { expectedConfigSha, config: next });
    const updated = (await update(created.configSha).expect(200)).body as ApplicationBody;
    expect(updated.configSha).not.toBe(created.configSha);
    expect(updated.config).toMatchObject({ run: { port: 8080 } });
    await update(created.configSha)
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'application_config_changed' });
      });
    await update(updated.configSha, config({ name: 'other-name' })).expect(400);
    // Saving the same configuration again changes and records nothing.
    await update(updated.configSha).expect(200);

    const events = await auditLog().findMany({
      where: { targetId: created.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => event.action)).toEqual([
      'application.created',
      'application.updated',
    ]);
    expect(JSON.stringify(events)).not.toContain('ghcr.io');
  });

  it('refuses invalid or unsupported configurations', async () => {
    for (const body of [
      {},
      { config: 'version: 1' },
      { config: config({ name: '../../etc' }) },
      { config: config({ build: { type: 'image', image: 'evil;rm -rf /' } }) },
      { config: config({ run: { port: 3000, command: 'sh -c id' } }) },
      { config: config({ build: { type: 'dockerfile' } }) },
      { config: config(), extra: true },
    ])
      await fixture.post(path(), 'owner', body).expect(400);
  });

  it('accepts configurations above the default 16 KiB body limit, within bounds', async () => {
    const env = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`VAR_${String(index)}`, 'v'.repeat(1000)]),
      );
    await fixture
      .post(path(), 'owner', { config: config({ name: 'large-config', env: env(40) }) })
      .expect(201);
    await fixture
      .post(path(), 'owner', { config: config({ name: 'too-large', env: env(100) }) })
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'application_config_too_large' });
      });
    await fixture
      .post(path(), 'owner', { config: config({ name: 'oversized', env: env(300) }) })
      .expect(413);
  });

  it('keeps developers off protected environments and hides other tenants', async () => {
    for (const actor of [
      'projectDeveloper',
      'environmentDeveloper',
      'environmentViewer',
      'member',
      'outsider',
    ] as const)
      await fixture.post(path(), actor, { config: config({ name: 'denied' }) }).expect(404);
    await fixture.get(path(), 'outsider').expect(404);
    await fixture
      .get(`${path()}/0190f5a8-7b1c-7e2d-8f3a-0123456789ab`, 'owner')
      .expect(404)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'application_not_found' });
      });
  });
});

/** PLAN M3.6a: a hostname belongs to one application per organization. */
describe('application domains over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  const path = () => `${fixture.environment}/applications`;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('refuses a claimed hostname, frees it on change and refuses wildcards', async () => {
    const first = (
      await fixture
        .post(path(), 'owner', {
          config: config({ name: 'first-app', domains: ['shared.example.com'] }),
        })
        .expect(201)
    ).body as ApplicationBody;
    await fixture
      .post(path(), 'owner', {
        config: config({ name: 'second-app', domains: ['shared.example.com'] }),
      })
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'domain_taken',
          details: { hostname: 'shared.example.com' },
        });
      });
    // The refused application was rolled back with its claim.
    const listed = await fixture.get(path(), 'owner').expect(200);
    expect((listed.body as { items: { name: string }[] }).items.map((a) => a.name)).toEqual([
      'first-app',
    ]);
    await fixture
      .post(`${path()}/${first.id}/config`, 'owner', {
        expectedConfigSha: first.configSha,
        config: config({ name: 'first-app', domains: ['other.example.com'] }),
      })
      .expect(200);
    await fixture
      .post(path(), 'owner', {
        config: config({ name: 'second-app', domains: ['shared.example.com'] }),
      })
      .expect(201);
    await fixture
      .post(path(), 'owner', { config: config({ name: 'wild-app', domains: ['*.example.com'] }) })
      .expect(400);
  });
});
