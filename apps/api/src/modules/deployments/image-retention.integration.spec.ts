import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { AppConfig } from '../../platform/config/app-config';
import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { auditLog } from '../../testing/audit-log';
import { distribution } from '../../testing/distribution';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { REGISTRY_TOKEN_KEY, type RegistryTokenKeyProvider } from '../fleet/application/ports';
import { compactToken, signingInput, tokenClaims } from '../registries/domain/registry-token';
import { DistributionStorage } from '../registries/infrastructure/distribution-storage';

import { ImageRetention } from './application/image-retention';
import { RETENTION_STORE, type RetentionStore } from './application/ports';

const sha256 = (data: Buffer) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

/**
 * ADR 0030 against a real CNCF Distribution and PostgreSQL: retention keeps the six releases last
 * deployed with success and what a deployment still runs, removes the rest from the registry, and
 * empties the repository of an application that no longer exists.
 */
describe('image retention with Distribution', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let registry: Awaited<ReturnType<typeof distribution>> | undefined;
  let admin: Client | undefined;
  let directory = '';
  let service = '';

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'shipkeep-retention-'));
    process.env['REGISTRY_JWKS_FILE'] = join(directory, 'jwks.json');
    fixture = await tenantHttpFixture();
    service = new URL(fixture.app.get(AppConfig).get('API_PUBLIC_URL')).host;
    registry = await distribution(join(directory, 'jwks.json'), service);
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
  });
  // Whatever failed before, the fixture closes: its database role outlives it otherwise.
  afterAll(async () => {
    Reflect.deleteProperty(process.env, 'REGISTRY_JWKS_FILE');
    try {
      await admin?.end();
      await registry?.stop();
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  /** A push token the control plane signs, as a build's grant buys one. */
  const pushToken = async (repository: string) => {
    const keys = fixture.app.get<RegistryTokenKeyProvider>(REGISTRY_TOKEN_KEY);
    const key = await keys.registryKey();
    const now = new Date();
    const claims = tokenClaims({
      service,
      subject: 'retention-test',
      access: [{ type: 'repository', name: repository, actions: ['pull', 'push'] }],
      id: uuidv7(),
      now,
      grantExpiresAt: new Date(now.getTime() + 300_000),
    });
    const input = signingInput(key.keyId, claims);
    return compactToken(input, await keys.signRegistryToken(Buffer.from(input, 'utf8')));
  };
  const blob = async (repository: string, token: string, data: Buffer) => {
    const base = registry?.url ?? '';
    const started = await fetch(`${base}/v2/${repository}/blobs/uploads/`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(started.status).toBe(202);
    const location = new URL(started.headers.get('location') ?? '', base);
    location.searchParams.set('digest', sha256(data));
    const put = await fetch(location, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: data,
    });
    expect(put.status).toBe(201);
    return { digest: sha256(data), size: data.length };
  };
  /** A small image of its own under `tag`; answers its manifest's digest. */
  const push = async (repository: string, tag: string, seed: string) => {
    const token = await pushToken(repository);
    const config = await blob(repository, token, Buffer.from(JSON.stringify({ seed })));
    const layer = await blob(repository, token, Buffer.from(`layer of ${seed}`));
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', ...config },
        layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', ...layer }],
      }),
    );
    const put = await fetch(`${registry?.url ?? ''}/v2/${repository}/manifests/${tag}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/vnd.oci.image.manifest.v1+json',
      },
      body: manifest,
    });
    expect(put.status).toBe(201);
    return sha256(manifest);
  };

  it('keeps what a rollback can reach and a deployment needs, and removes the rest', async () => {
    const created = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'kept-api',
          build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
          run: { port: 3000 },
        },
      })
      .expect(201);
    const applicationId = (created.body as { id: string }).id;
    // Releases 1 to 8, each deployed with success in turn; release 9's deployment still runs.
    for (let number = 1; number <= 9; number++) {
      const deployed = await fixture
        .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
        .expect(201);
      if (number === 9) break;
      await admin?.query(
        `UPDATE deployments SET state = 'succeeded', finished_at = now() + make_interval(secs => $2)
         WHERE id = $1`,
        [(deployed.body as { deployment: { id: string } }).deployment.id, number],
      );
    }
    const repository = `${fixture.organizationId}/${applicationId}`;
    const digests = new Map<string, string>();
    for (const tag of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'stray'])
      digests.set(tag, await push(repository, tag, `${applicationId}-${tag}`));
    // A tag of its own on release 8's manifest: it goes with nothing, since 8 is kept.
    await push(repository, 'latest', `${applicationId}-8`);
    // The repository of an application that no longer exists.
    const gone = `${fixture.organizationId}/0190f5a8-7b1c-7e2d-8f3a-0000000000ff`;
    await push(gone, '1', 'gone-1');

    const storage = new DistributionStorage(
      { get: () => registry?.url ?? '' } as unknown as AppConfig,
      fixture.app.get<RegistryTokenKeyProvider>(REGISTRY_TOKEN_KEY),
      service,
    );
    const retention = new ImageRetention(
      storage,
      fixture.app.get<RetentionStore>(RETENTION_STORE),
      fixture.app.get(PrismaUnitOfWork),
      fixture.app.get(DomainEventBus),
    );
    const result = await retention.run();

    // Releases 3 to 8 are the six last deployed with success, 9 still deploys; 1, 2 and the
    // stray tag go, and the repository of the application that is gone is emptied.
    expect((await storage.tags(repository)).sort()).toEqual(
      ['3', '4', '5', '6', '7', '8', '9', 'latest'].sort(),
    );
    expect(await storage.digest(repository, '8')).toBe(digests.get('8'));
    expect(await storage.digest(repository, '1')).toBeUndefined();
    expect(await storage.tags(gone)).toEqual([]);
    expect(result.deleted).toBe(4);
    const events = await auditLog().findMany({
      where: { action: 'application.images_pruned', targetId: applicationId },
    });
    expect(events.map((event) => event.metadata)).toMatchObject([
      { tags: '1,2,stray', count: 3, applicationId },
    ]);
    // A second run finds nothing more to remove.
    expect((await retention.run()).deleted).toBe(0);
  });
});
