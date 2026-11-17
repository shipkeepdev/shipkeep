import { Client } from 'pg';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { REGISTRY_CREDENTIAL_STORE, type RegistryCredentialStore } from './application/ports';

/** Obviously fake values: no real token has this shape. */
const FIRST = 'sk_test_fake_registry_password_one';
const SECOND = 'sk_test_fake_registry_password_two "$\\ it\'s';

interface Stored {
  id: string;
  server: string;
  username: string;
  version: number;
}

/** ADR 0019: registry credentials over HTTP, with PostgreSQL and the restricted runtime role. */
describe('registry credentials over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let admin: Client;
  const path = () => `${fixture.root}/registries`;
  const login = (server: string) =>
    fixture.app
      .get(PrismaUnitOfWork)
      .runTenant(fixture.organizationId, () =>
        fixture.app
          .get<RegistryCredentialStore>(REGISTRY_CREDENTIAL_STORE)
          .login(fixture.organizationId, server),
      );

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
  });
  afterAll(async () => {
    await admin.end();
    await fixture.close();
  });

  it('stores credentials write-only, encrypted, and replaces them by registry', async () => {
    const created = await fixture
      .post(path(), 'owner', { server: 'GHCR.io', username: 'deploy-bot', password: FIRST })
      .expect(200);
    const stored = created.body as Stored;
    expect(stored).toMatchObject({ server: 'ghcr.io', username: 'deploy-bot', version: 1 });
    expect(JSON.stringify(created.body)).not.toContain(FIRST);

    const listed = await fixture.get(path(), 'admin').expect(200);
    expect((listed.body as { items: Stored[] }).items).toMatchObject([
      { id: stored.id, server: 'ghcr.io', username: 'deploy-bot', version: 1 },
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(FIRST);

    // At rest the password is ciphertext, and it decrypts only for this organization and registry.
    const rows = await admin.query<{ password_enc: Buffer }>(
      'SELECT password_enc FROM registry_credentials WHERE id = $1',
      [stored.id],
    );
    expect(rows.rows[0]?.password_enc.includes(Buffer.from(FIRST))).toBe(false);
    expect((await login('ghcr.io'))?.password.expose()).toBe(FIRST);
    expect(await login('quay.io')).toBeUndefined();

    // The same registry again replaces them: same row, next version, new password.
    const replaced = await fixture
      .post(path(), 'admin', { server: 'ghcr.io', username: 'release-bot', password: SECOND })
      .expect(200);
    expect(replaced.body).toMatchObject({
      id: stored.id,
      server: 'ghcr.io',
      username: 'release-bot',
      version: 2,
    });
    expect(await login('ghcr.io')).toMatchObject({ server: 'ghcr.io', username: 'release-bot' });
    expect((await login('ghcr.io'))?.password.expose()).toBe(SECOND);

    // Docker Hub has one name, however it is written.
    const hub = await fixture
      .post(path(), 'owner', { server: 'index.docker.io', username: 'acme', password: FIRST })
      .expect(200);
    expect(hub.body).toMatchObject({ server: 'docker.io', version: 1 });

    // A row moved to another registry no longer decrypts: the ciphertext is bound to its registry.
    await admin.query("UPDATE registry_credentials SET server = 'quay.io' WHERE id = $1", [
      (hub.body as Stored).id,
    ]);
    await expect(login('quay.io')).rejects.toThrow();
    await admin.query("UPDATE registry_credentials SET server = 'docker.io' WHERE id = $1", [
      (hub.body as Stored).id,
    ]);
    expect((await login('docker.io'))?.password.expose()).toBe(FIRST);
  });

  it('is managed only by who administers the organization', async () => {
    const before = await fixture.get(path(), 'owner').expect(200);
    const id = (before.body as { items: Stored[] }).items[0]?.id ?? '';
    for (const actor of [
      'member',
      'projectAdmin',
      'environmentAdmin',
      'environmentDeveloper',
      'environmentViewer',
      'outsider',
    ] as const) {
      await fixture.get(path(), actor).expect(404);
      await fixture
        .post(path(), actor, { server: 'quay.io', username: 'x', password: FIRST })
        .expect(404);
      await fixture.post(`${path()}/${id}/remove`, actor, {}).expect(404);
    }
    const after = await fixture.get(path(), 'owner').expect(200);
    expect(after.body).toEqual(before.body);
  });

  it('refuses what is not a registry host, and never echoes a password', async () => {
    for (const server of ['https://ghcr.io', 'ghcr.io/acme', 'user:pw@ghcr.io', 'ghcr.io:70000'])
      await fixture
        .post(path(), 'owner', { server, username: 'deploy', password: FIRST })
        .expect(400)
        .expect((response) => {
          expect(response.body).toMatchObject({ code: 'invalid_registry_server' });
        });
    const multiline = `${FIRST}\nX-Injected: 1`;
    for (const password of [multiline, 'x'.repeat(4097), ''])
      await fixture
        .post(path(), 'owner', { server: 'ghcr.io', username: 'deploy', password })
        .expect(400)
        .expect((response) => {
          expect(JSON.stringify(response.body)).not.toContain(FIRST);
        });
    await fixture
      .post(path(), 'owner', { server: 'ghcr.io', username: 'de\nploy', password: FIRST })
      .expect(400);
    // Nothing was changed by the refusals.
    expect((await login('ghcr.io'))?.password.expose()).toBe(SECOND);
  });

  it('removes credentials once, and audits every change without the password', async () => {
    const listed = await fixture.get(path(), 'owner').expect(200);
    const ghcr = (listed.body as { items: Stored[] }).items.find((r) => r.server === 'ghcr.io');
    await fixture.post(`${path()}/${ghcr?.id ?? ''}/remove`, 'admin', {}).expect(204);
    await fixture.post(`${path()}/${ghcr?.id ?? ''}/remove`, 'admin', {}).expect(404);
    expect(await login('ghcr.io')).toBeUndefined();
    expect(
      ((await fixture.get(path(), 'owner').expect(200)).body as { items: Stored[] }).items.map(
        (r) => r.server,
      ),
    ).toEqual(['docker.io']);

    const events = await auditLog().findMany({
      where: { action: { startsWith: 'registry.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => [event.action, event.metadata])).toEqual([
      ['registry.credentials_set', { server: 'ghcr.io', username: 'deploy-bot', version: 1 }],
      ['registry.credentials_set', { server: 'ghcr.io', username: 'release-bot', version: 2 }],
      ['registry.credentials_set', { server: 'docker.io', username: 'acme', version: 1 }],
      ['registry.credentials_removed', { server: 'ghcr.io', username: 'release-bot', version: 2 }],
    ]);
    const everything = JSON.stringify(await auditLog().findMany({}));
    expect(everything).not.toContain(FIRST);
    expect(everything).not.toContain('registry_password_two');
  });
});
