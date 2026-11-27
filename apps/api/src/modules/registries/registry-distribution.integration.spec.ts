import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppConfig } from '../../platform/config/app-config';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { distribution } from '../../testing/distribution';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { RegistryGrants } from './application/registry-grants';

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/**
 * ADR 0030 against a real CNCF Distribution: the registry trusts the key the control plane
 * publishes, lets a build's grant push to its application's repository, and refuses the rest.
 */
describe('the installation registry with Distribution', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let registry: Awaited<ReturnType<typeof distribution>> | undefined;
  let directory = '';
  let applicationId = '';
  let service = '';

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'shipkeep-distribution-'));
    process.env['REGISTRY_JWKS_FILE'] = join(directory, 'jwks.json');
    fixture = await tenantHttpFixture();
    service = new URL(fixture.app.get(AppConfig).get('API_PUBLIC_URL')).host;
    registry = await distribution(join(directory, 'jwks.json'), service);
    const created = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'pushed-api',
          build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
          run: { port: 3000 },
        },
      })
      .expect(201);
    applicationId = (created.body as { id: string }).id;
  });
  afterAll(async () => {
    Reflect.deleteProperty(process.env, 'REGISTRY_JWKS_FILE');
    await registry?.stop();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });

  const tokenFor = async (push: boolean, scope: string) => {
    const grant = await fixture.app
      .get(PrismaUnitOfWork)
      .runTenant(fixture.organizationId, () =>
        fixture.app
          .get(RegistryGrants)
          .issue(
            { organizationId: fixture.organizationId, id: applicationId },
            { push, expiresAt: new Date(Date.now() + 600_000) },
          ),
      );
    const query = new URLSearchParams({ service, scope });
    const answer = await fixture
      .http()
      .get(`/api/v1/registry/token?${query.toString()}`)
      .set('authorization', basic(grant.username, grant.secret.expose()))
      .expect(200);
    return (answer.body as { token: string }).token;
  };
  const upload = (repository: string, token: string) =>
    fetch(`${registry?.url ?? ''}/v2/${repository}/blobs/uploads/`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

  it("pushes with a build's grant, to its application's repository only", async () => {
    const repository = `${fixture.organizationId}/${applicationId}`;
    const push = await tokenFor(true, `repository:${repository}:pull,push`);
    expect((await upload(repository, push)).status).toBe(202);
    // Another application's repository, in the same organization: refused by the registry.
    const other = `${fixture.organizationId}/0190f5a8-7b1c-7e2d-8f3a-0000000000ff`;
    expect((await upload(other, push)).status).toBe(401);
    // A deploying server's grant pulls, and cannot push.
    const pull = await tokenFor(false, `repository:${repository}:pull,push`);
    expect((await upload(repository, pull)).status).toBe(401);
    // A token the control plane did not sign is refused.
    const [head = '', claims = ''] = push.split('.');
    expect((await upload(repository, `${head}.${claims}.${'A'.repeat(86)}`)).status).toBe(401);
  });
});
