import { Client } from 'pg';

import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';

interface Queued {
  release: { id: string; number: number; image: string; imageDigest: string | null };
  deployment: { id: string; state: string; build: boolean; release: boolean; releaseId: string };
}

/** PLAN M3.4b2: releases and queued deployments for image applications. */
describe('deployments over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let application: string;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    const created = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'billing-api',
          build: { type: 'image', image: 'ghcr.io/acme/billing:1.4.2' },
          run: { port: 3000 },
          release: { command: ['node', 'migrate.js'] },
          secrets: ['DATABASE_URL'],
        },
      })
      .expect(201);
    application = `${fixture.environment}/applications/${(created.body as { id: string }).id}`;
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('queues one deployment at a time, once referenced secrets are set', async () => {
    await fixture
      .post(`${application}/deployments`, 'owner', {})
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({
          code: 'secrets_missing',
          details: { missing: ['DATABASE_URL'] },
        });
      });
    await fixture
      .post(`${fixture.environment}/secrets`, 'owner', { name: 'DATABASE_URL', value: 'x' })
      .expect(200);

    const first = (
      await fixture.post(`${application}/deployments`, 'environmentAdmin', {}).expect(201)
    ).body as Queued;
    expect(first.release).toMatchObject({
      number: 1,
      image: 'ghcr.io/acme/billing:1.4.2',
      imageDigest: null,
    });
    expect(first.deployment).toMatchObject({
      state: 'queued',
      build: false,
      release: true,
      releaseId: first.release.id,
    });
    await fixture
      .post(`${application}/deployments`, 'owner', {})
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'deployment_in_progress' });
      });

    const deployment = `${application}/deployments/${first.deployment.id}`;
    await fixture.get(deployment, 'environmentViewer').expect(200);
    const cancelled = await fixture.post(`${deployment}/cancel`, 'owner', {}).expect(200);
    expect(cancelled.body).toMatchObject({ state: 'cancelled', error: 'Cancelled by a user.' });
    await fixture
      .post(`${deployment}/cancel`, 'owner', {})
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'invalid_deployment_transition' });
      });

    const second = (await fixture.post(`${application}/deployments`, 'owner', {}).expect(201))
      .body as Queued;
    expect(second.release.number).toBe(2);
    const releases = await fixture.get(`${application}/releases`, 'environmentViewer').expect(200);
    expect((releases.body as { items: { number: number }[] }).items.map((r) => r.number)).toEqual([
      2, 1,
    ]);
    const listed = await fixture.get(`${application}/deployments`, 'environmentViewer').expect(200);
    expect(
      (listed.body as { items: { id: string; state: string }[] }).items.map((d) => d.state),
    ).toEqual(['queued', 'cancelled']);

    const actions = (await auditLog().findMany({ orderBy: { createdAt: 'asc' } }))
      .map((event) => event.action)
      .filter((action) => /^(release|deployment)\./.test(action));
    expect(actions).toEqual([
      'release.created',
      'deployment.queued',
      'deployment.cancelled',
      'release.created',
      'deployment.queued',
    ]);
  });

  it('keeps releases immutable except for a single image digest', async () => {
    const admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ id: string }>(
        'SELECT id FROM releases ORDER BY number LIMIT 1',
      );
      const id = rows[0]?.id;
      await expect(
        admin.query("UPDATE releases SET image='ghcr.io/evil/other:1' WHERE id=$1", [id]),
      ).rejects.toThrow(/immutable/);
      const digest = `sha256:${'a'.repeat(64)}`;
      await admin.query('UPDATE releases SET image_digest=$2 WHERE id=$1', [id, digest]);
      await expect(
        admin.query('UPDATE releases SET image_digest=$2 WHERE id=$1', [
          id,
          `sha256:${'b'.repeat(64)}`,
        ]),
      ).rejects.toThrow(/immutable/);
      // A second active deployment cannot exist, even written directly.
      await expect(
        admin.query(
          `INSERT INTO deployments (id, organization_id, application_id, release_id, state, plan_build,
             plan_release, trigger, started_at, updated_at)
           SELECT gen_random_uuid(), organization_id, application_id, release_id, 'scheduling',
             false, false, 'manual', now(), now() FROM deployments WHERE state='queued' LIMIT 1`,
        ),
      ).rejects.toThrow(/deployments_one_active_key/);
    } finally {
      await admin.end();
    }
  });

  it('keeps developers off protected environments and hides unknown applications', async () => {
    for (const actor of ['projectDeveloper', 'environmentDeveloper', 'environmentViewer'] as const)
      await fixture.post(`${application}/deployments`, actor, {}).expect(404);
    await fixture.get(`${application}/deployments`, 'outsider').expect(404);
    await fixture
      .post(
        `${fixture.environment}/applications/0190f5a8-7b1c-7e2d-8f3a-0123456789ab/deployments`,
        'owner',
        {},
      )
      .expect(404)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'application_not_found' });
      });
  });
});

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
