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
