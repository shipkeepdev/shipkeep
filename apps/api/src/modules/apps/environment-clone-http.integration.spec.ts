import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';

const config = (name: string, overrides: Record<string, unknown> = {}) => ({
  version: 1,
  name,
  build: { type: 'image', image: 'ghcr.io/acme/billing:1.4.2' },
  run: { port: 3000 },
  ...overrides,
});

interface ApplicationBody {
  id: string;
  name: string;
  config: Record<string, unknown>;
}
interface CloneBody {
  environmentId: string;
  name: string;
  applications: ApplicationBody[];
}

/** Issue #257: cloning an environment copies its applications, not deployed, without domains. */
describe('environment clone over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  const clone = () => `${fixture.environment}/clone`;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('copies the settings and the applications, keeps secret names, leaves domains and data', async () => {
    const applications = `${fixture.environment}/applications`;
    await fixture
      .post(applications, 'owner', {
        config: config('billing-api', {
          domains: ['billing.example.com'],
          secrets: ['DATABASE_URL'],
          env: { MODE: 'eu' },
        }),
      })
      .expect(201);
    await fixture.post(applications, 'owner', { config: config('worker') }).expect(201);

    const cloned = (await fixture.post(clone(), 'projectAdmin', { name: 'staging' }).expect(201))
      .body as CloneBody;
    expect(cloned.name).toBe('staging');
    expect(cloned.applications.map((app) => app.name).sort()).toEqual(['billing-api', 'worker']);
    const billing = cloned.applications.find((app) => app.name === 'billing-api');
    expect(billing?.config).toMatchObject({ secrets: ['DATABASE_URL'], env: { MODE: 'eu' } });
    expect(billing?.config).not.toHaveProperty('domains');

    const target = `${fixture.project}/environments/${cloned.environmentId}`;
    const listed = await fixture.get(`${target}/applications`, 'projectViewer').expect(200);
    expect((listed.body as { items: unknown[] }).items).toHaveLength(2);
    // The domain still belongs to the source application only.
    const rows = await fixture.database.runTenant(fixture.organizationId, () =>
      fixture.database.client.domain.findMany({ where: { hostname: 'billing.example.com' } }),
    );
    expect(rows).toHaveLength(1);
    expect(cloned.applications.map((app) => app.id)).not.toContain(rows.at(0)?.applicationId);
    // Nothing is deployed in the clone.
    const deployments = await fixture.database.runTenant(fixture.organizationId, () =>
      fixture.database.client.deployment.count({
        where: { application: { environmentId: cloned.environmentId } },
      }),
    );
    expect(deployments).toBe(0);
    const environment = await fixture.database.runTenant(fixture.organizationId, () =>
      fixture.database.client.environment.findFirstOrThrow({
        where: { id: cloned.environmentId },
      }),
    );
    expect(environment).toMatchObject({ name: 'staging', protected: true, kind: 'standard' });

    const created = await auditLog().findMany({
      where: { action: 'environment.created', targetId: cloned.environmentId },
    });
    expect(created).toHaveLength(1);
    expect(created.at(0)?.metadata).toMatchObject({ clonedFrom: fixture.environmentId });
    const copies = await auditLog().findMany({
      where: {
        action: 'application.created',
        targetId: { in: cloned.applications.map((a) => a.id) },
      },
    });
    expect(copies).toHaveLength(2);

    // The same name again is refused, and creates nothing.
    await fixture.post(clone(), 'projectAdmin', { name: 'staging' }).expect(409);
  });

  it('refuses invalid names and callers who cannot create environments', async () => {
    await fixture.post(clone(), 'owner', { name: 'Not A Slug!' }).expect(400);
    for (const actor of [
      'projectDeveloper',
      'projectViewer',
      'environmentAdmin',
      'member',
      'outsider',
    ] as const)
      await fixture.post(clone(), actor, { name: `denied-${actor.toLowerCase()}` }).expect(404);
    const unknown = `${fixture.project}/environments/0190f5a8-7b1c-7e2d-8f3a-0123456789ab/clone`;
    await fixture.post(unknown, 'owner', { name: 'from-nowhere' }).expect(404);
    const names = await fixture.database.runTenant(fixture.organizationId, () =>
      fixture.database.client.environment.findMany({ select: { name: true } }),
    );
    expect(names.map((row) => row.name)).not.toContain('from-nowhere');
    expect(names.some((row) => row.name.startsWith('denied-'))).toBe(false);
  });
});
