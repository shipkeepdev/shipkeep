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
import { distribution, registryStorage } from '../../testing/distribution';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { REGISTRY_TOKEN_KEY, type RegistryTokenKeyProvider } from '../fleet/application/ports';
import type { RegistryStorage } from '../registries/application/ports';
import { compactToken, signingInput, tokenClaims } from '../registries/domain/registry-token';

import { ImageRetention } from './application/image-retention';
import { RETENTION_STORE, type RetentionStore } from './application/ports';

const sha256 = (data: Buffer) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

/**
 * ADR 0030 against a real CNCF Distribution and PostgreSQL: retention keeps the tags the six
 * releases last deployed with success run and those a deployment still needs, removes the other
 * tags and only them, and empties the repository of an application that no longer exists.
 */
describe('image retention with Distribution', () => {
  let opened: Awaited<ReturnType<typeof tenantHttpFixture>> | undefined;
  let registry: Awaited<ReturnType<typeof distribution>> | undefined;
  let admin: Client | undefined;
  let directory = '';
  let service = '';
  const fixture = () => {
    if (!opened) throw new Error('the fixture did not start');
    return opened;
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'shipkeep-retention-'));
    process.env['REGISTRY_JWKS_FILE'] = join(directory, 'jwks.json');
    opened = await tenantHttpFixture();
    service = new URL(opened.app.get(AppConfig).get('API_PUBLIC_URL')).host;
    registry = await distribution(join(directory, 'jwks.json'), service);
    admin = new Client({ connectionString: opened.databaseUrl });
    await admin.connect();
  });
  // Each resource closes whatever failed before: the fixture's database role outlives it otherwise.
  afterAll(async () => {
    Reflect.deleteProperty(process.env, 'REGISTRY_JWKS_FILE');
    const failures: unknown[] = [];
    for (const close of [
      () => admin?.end(),
      () => registry?.stop(),
      () => opened?.close(),
      () => (directory ? rm(directory, { recursive: true, force: true }) : undefined),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  });

  /** A push token the control plane signs, as a build's grant buys one. */
  const pushToken = async (repository: string) => {
    const keys = fixture().app.get<RegistryTokenKeyProvider>(REGISTRY_TOKEN_KEY);
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
  /** A small image made from `seed` under `tag`: the same seed makes the same manifest. */
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
  /** The digest of the manifest `tag` names, or undefined when the tag is gone. */
  const named = async (repository: string, tag: string) => {
    const answer = await fetch(`${registry?.url ?? ''}/v2/${repository}/manifests/${tag}`, {
      method: 'HEAD',
      headers: {
        authorization: `Bearer ${await pushToken(repository)}`,
        accept: 'application/vnd.oci.image.manifest.v1+json',
      },
    });
    return answer.status === 404 ? undefined : (answer.headers.get('docker-content-digest') ?? '');
  };

  it('keeps the tags a rollback can reach and a deployment needs, and removes the others only', async () => {
    const created = await fixture()
      .post(`${fixture().environment}/applications`, 'owner', {
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
      const deployed = await fixture()
        .post(`${fixture().environment}/applications/${applicationId}/deployments`, 'owner', {})
        .expect(201);
      if (number === 9) break;
      await admin?.query(
        `UPDATE deployments SET state = 'succeeded', finished_at = now() + make_interval(secs => $2)
         WHERE id = $1`,
        [(deployed.body as { deployment: { id: string } }).deployment.id, number],
      );
    }
    const repository = `${fixture().organizationId}/${applicationId}`;
    // As built releases: each runs its own tag, but release 8 is a rollback's copy of release 2,
    // which runs release 2's tag. Releases are immutable: their trigger is set aside for this.
    await admin?.query('SET session_replication_role = replica');
    await admin?.query(
      `UPDATE releases SET image = $2 || ':' || CASE WHEN number = 8 THEN '2' ELSE number::text END
       WHERE application_id = $1`,
      [applicationId, `${service}/${repository}`],
    );
    await admin?.query('SET session_replication_role = origin');
    const digests = new Map<string, string>();
    for (const tag of ['1', '2', '3', '4', '5', '6', '7', '8', 'stray'])
      digests.set(tag, await push(repository, tag, `${applicationId}-${tag}`));
    // A tag of its own on release 3's manifest: it goes, and the manifest stays for tag 3.
    await push(repository, 'latest', `${applicationId}-3`);
    // The repository of an application that no longer exists.
    const gone = `${fixture().organizationId}/0190f5a8-7b1c-7e2d-8f3a-0000000000ff`;
    await push(gone, '1', 'gone-1');

    const storage = registryStorage(
      registry?.url ?? '',
      fixture().app.get<RegistryTokenKeyProvider>(REGISTRY_TOKEN_KEY),
      service,
    );
    // Release 9's build pushes once retention has read the tags, a manifest equal to tag 1's.
    let pushed = false;
    const racing: RegistryStorage = {
      repositories: (last, limit) => storage.repositories(last, limit),
      tags: async (name) => {
        const tags = await storage.tags(name);
        if (name === repository && !pushed) {
          pushed = true;
          await push(repository, '9', `${applicationId}-1`);
        }
        return tags;
      },
      deleteTag: (name, tag) => storage.deleteTag(name, tag),
    };
    const retention = new ImageRetention(
      racing,
      fixture().app.get<RetentionStore>(RETENTION_STORE),
      fixture().app.get(PrismaUnitOfWork),
      fixture().app.get(DomainEventBus),
    );
    const result = await retention.run();

    // Releases 3 to 8 are the six last deployed with success, release 8 running tag 2, and 9
    // still deploys. Tags 1 and 8, the stray one and `latest` go; so does the repository of the
    // application that is gone.
    expect((await storage.tags(repository)).sort()).toEqual(['2', '3', '4', '5', '6', '7', '9']);
    // Only tags went: the manifest `latest` shared with tag 3 stays, and so does the one tag 9,
    // pushed after the read, shares with the removed tag 1.
    expect(await named(repository, '3')).toBe(digests.get('3'));
    expect(await named(repository, '9')).toBe(digests.get('1'));
    expect(await named(repository, '1')).toBeUndefined();
    expect(await storage.tags(gone)).toEqual([]);
    expect(result.deleted).toBe(5);
    const events = await auditLog().findMany({
      where: { action: 'application.images_pruned', targetId: applicationId },
    });
    expect(events.map((event) => event.metadata)).toMatchObject([
      { tags: '1,8,latest,stray', count: 4, applicationId },
    ]);
    // A second run finds nothing more to remove.
    expect((await retention.run()).deleted).toBe(0);
  });
});
