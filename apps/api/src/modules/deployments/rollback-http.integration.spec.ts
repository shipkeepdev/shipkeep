import { Client } from 'pg';

import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';

interface Queued {
  release: { id: string; number: number; image: string; imageDigest: string | null };
  deployment: { id: string; state: string; build: boolean; release: boolean; releaseId: string };
}

/** PLAN M3.5a: rollback targets over HTTP, with the digest recorded by SQL. */
describe('rollback over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('copies the pinned release and refuses invalid targets', async () => {
    const created = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'rollback-api',
          build: { type: 'image', image: 'ghcr.io/acme/billing:1.4.2' },
          run: { port: 3000 },
          release: { command: ['node', 'migrate.js'] },
        },
      })
      .expect(201);
    const application = `${fixture.environment}/applications/${(created.body as { id: string }).id}`;
    const first = (await fixture.post(`${application}/deployments`, 'owner', {}).expect(201))
      .body as Queued;
    const target = `${application}/deployments/${first.deployment.id}/rollback`;

    // Still queued, so it never ran.
    await fixture
      .post(target, 'owner', {})
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'rollback_target_invalid' });
      });

    const admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    const digest = `sha256:${'a'.repeat(64)}`;
    const finish = (id: string) =>
      admin.query(
        "UPDATE deployments SET state='succeeded', finished_at=now(), updated_at=now() WHERE id=$1",
        [id],
      );
    try {
      await admin.query('UPDATE releases SET image_digest=$2 WHERE id=$1', [
        first.release.id,
        digest,
      ]);
      await finish(first.deployment.id);
      // It is the version serving now.
      await fixture
        .post(target, 'owner', {})
        .expect(409)
        .expect((response) => {
          expect(response.body).toMatchObject({ code: 'release_already_serving' });
        });

      const second = (await fixture.post(`${application}/deployments`, 'owner', {}).expect(201))
        .body as Queued;
      await finish(second.deployment.id);
      for (const actor of ['environmentDeveloper', 'environmentViewer', 'outsider'] as const)
        await fixture.post(target, actor, {}).expect(404);

      const rollback = (await fixture.post(target, 'environmentAdmin', {}).expect(201))
        .body as Queued;
      expect(rollback.release).toMatchObject({
        number: 3,
        image: 'ghcr.io/acme/billing:1.4.2',
        imageDigest: digest,
      });
      expect(rollback.deployment).toMatchObject({
        state: 'queued',
        trigger: 'rollback',
        build: false,
        release: false,
      });
      await fixture
        .post(target, 'owner', {})
        .expect(409)
        .expect((response) => {
          expect(response.body).toMatchObject({ code: 'deployment_in_progress' });
        });
    } finally {
      await admin.end();
    }
  });
});
