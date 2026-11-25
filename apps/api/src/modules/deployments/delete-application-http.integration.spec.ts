import { Client } from 'pg';

import { auditLog } from '../../testing/audit-log';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';
import type { TenantActor } from '../../testing/tenant-personas';

import { DeploymentPipeline } from './application/deployment-pipeline';

/** Issue #256: deleting an application over HTTP, with the real pipeline and PostgreSQL. */
describe('deleting an application over HTTP', () => {
  // The node's heartbeat and the pipeline's clock: the node stays ready however long this takes.
  const NOW = new Date();
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let nodeId: string;
  let admin: Client;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    nodeId = await enrollTestNode(fixture, {
      facts: {
        hostname: 'edge-delete.example.com',
        architecture: 'amd64',
        cpu_count: 2,
        memory_bytes: 2 ** 32,
      },
      heartbeatAt: NOW,
    });
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
  });
  afterAll(async () => {
    await admin.end();
    await fixture.close();
  });

  const create = async (name: string, hostname: string) =>
    (
      await fixture
        .post(`${fixture.environment}/applications`, 'owner', {
          config: {
            version: 1,
            name,
            // Already pinned: no registry request in tests.
            build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
            run: { port: 3000 },
            domains: [hostname],
          },
        })
        .expect(201)
    ).body as { id: string };
  /** Runs the pipeline, letting the agents succeed at every action it queues. */
  async function runToTheEnd(deploymentId: string): Promise<void> {
    const pipeline = fixture.app.get(DeploymentPipeline);
    for (let round = 0; round < 10; round++) {
      if ((await pipeline.run(fixture.organizationId, deploymentId, () => NOW)) === 'done') return;
      await admin.query(
        `UPDATE agent_actions SET state = 'succeeded', completed_at = now(), updated_at = now()
         WHERE deployment_id = $1 AND state = 'queued'`,
        [deploymentId],
      );
    }
    throw new Error('the deployment did not finish');
  }
  const confirmation = (actor: TenantActor, target: string, name: string) =>
    fixture.post(`${fixture.root}/confirmations`, actor, {
      action: 'application.delete',
      target,
      name,
    });
  const count = async (table: string, applicationId: string) =>
    Number(
      (
        await admin.query<{ rows: string }>(
          `SELECT count(*) AS rows FROM ${table} WHERE application_id = $1`,
          [applicationId],
        )
      ).rows[0]?.rows,
    );

  it('needs a stopped application, the right to administer it and its typed name', async () => {
    const { id } = await create('doomed-api', 'doomed.example.com');
    const application = `${fixture.environment}/applications/${id}`;
    const deployed = (await fixture.post(`${application}/deployments`, 'owner', {}).expect(201))
      .body as { deployment: { id: string } };
    expect(
      await fixture.app
        .get(DeploymentPipeline)
        .run(fixture.organizationId, deployed.deployment.id, () => NOW),
    ).toBe('wait');
    await admin.query(
      "UPDATE deployments SET state='succeeded', finished_at=$2, updated_at=$2 WHERE id=$1",
      [deployed.deployment.id, new Date(NOW.getTime() - 1000)],
    );

    // Only who administers the environment may ask for the confirmation, with the exact name.
    for (const actor of ['environmentDeveloper', 'environmentViewer', 'outsider'] as const)
      await confirmation(actor, id, 'doomed-api').expect(404);
    await confirmation('environmentAdmin', id, 'doomed')
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'confirmation_name_mismatch' });
      });
    const issued = (await confirmation('environmentAdmin', id, 'doomed-api').expect(201)).body as {
      id: string;
      token: string;
    };

    // It still runs: refused, and the confirmation is not spent by the refusal.
    await fixture
      .post(`${application}/delete`, 'environmentAdmin', { confirmation: issued.token })
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'application_running' });
      });
    const stopping = (await fixture.post(`${application}/stop`, 'owner', {}).expect(201)).body as {
      id: string;
    };
    // While the stop runs, nothing may be deleted under it.
    await fixture
      .post(`${application}/delete`, 'environmentAdmin', { confirmation: issued.token })
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'deployment_in_progress' });
      });
    await runToTheEnd(stopping.id);

    // A confirmation belongs to one account and one application.
    const other = await create('survivor-api', 'survivor.example.com');
    const forOther = (await confirmation('environmentAdmin', other.id, 'survivor-api').expect(201))
      .body as { token: string };
    for (const [actor, token] of [
      ['environmentAdmin', forOther.token],
      ['environmentAdmin', 'not-a-token'],
      ['owner', issued.token],
    ] as const)
      await fixture
        .post(`${application}/delete`, actor, { confirmation: token })
        .expect(400)
        .expect((response) => {
          expect(response.body).toMatchObject({ code: 'confirmation_rejected' });
        });
    for (const actor of ['environmentDeveloper', 'environmentViewer', 'outsider'] as const)
      await fixture
        .post(`${application}/delete`, actor, { confirmation: issued.token })
        .expect(404);
    expect(await count('deployments', id)).toBe(2);

    await fixture
      .post(`${application}/delete`, 'environmentAdmin', { confirmation: issued.token })
      .expect(204);

    // The application and everything that belonged to it are gone...
    await fixture.get(application, 'owner').expect(404);
    for (const table of ['deployments', 'releases', 'allocations', 'domains'])
      expect(await count(table, id)).toBe(0);
    // ...the servers' action history and the audit log are not.
    const history = await admin.query(
      'SELECT 1 FROM agent_actions WHERE node_id = $1 AND application_id IS NULL',
      [nodeId],
    );
    expect(history.rowCount).toBeGreaterThan(0);
    const events = await auditLog().findMany({ where: { targetId: id } });
    expect(events.map((event) => event.action).sort()).toEqual([
      'application.created',
      'application.deleted',
    ]);
    expect(events.find((event) => event.action === 'application.deleted')?.metadata).toMatchObject({
      name: 'doomed-api',
      confirmationId: issued.id,
    });
    // Its name and its domain are free again; the other application was not touched.
    await create('doomed-api', 'doomed.example.com');
    await fixture.get(`${fixture.environment}/applications/${other.id}`, 'owner').expect(200);
    // The confirmation is spent, and its target no longer exists.
    await fixture
      .post(`${application}/delete`, 'environmentAdmin', { confirmation: issued.token })
      .expect(404);
  });

  describe('after a first deployment that failed with a container created (#474)', () => {
    /** A first deployment whose container was created, then failed: its cleanup is queued. */
    async function failedFirst(name: string, hostname: string) {
      const { id } = await create(name, hostname);
      const application = `${fixture.environment}/applications/${id}`;
      const deployed = (await fixture.post(`${application}/deployments`, 'owner', {}).expect(201))
        .body as { deployment: { id: string } };
      await runToTheEnd(deployed.deployment.id);
      const rows = await admin.query<{ id: string; kind: string; state: string }>(
        'SELECT id, kind, state FROM agent_actions WHERE deployment_id = $1',
        [deployed.deployment.id],
      );
      const of = (kind: string) => {
        const found = rows.rows.find((row) => row.kind === kind);
        if (!found) throw new Error(`no ${kind} action`);
        return found;
      };
      // The scenario of the issue: created, the deployment failed, its cleanup not run yet.
      expect(of('createContainer').state).toBe('succeeded');
      expect(of('removeContainer').state).toBe('queued');
      expect(await count('allocations', id)).toBe(1);
      return {
        id,
        application,
        creation: of('createContainer').id,
        cleanup: of('removeContainer').id,
      };
    }
    const set = (actionId: string, state: string, attempts = 1) =>
      admin.query('UPDATE agent_actions SET state = $2, attempts = $3 WHERE id = $1', [
        actionId,
        state,
        attempts,
      ]);
    /** A confirmation for the application, then the request that deletes it with it. */
    const issue = async (target: { id: string }, name: string) =>
      ((await confirmation('owner', target.id, name).expect(201)).body as { token: string }).token;
    const remove = (target: { application: string }, token: string) =>
      fixture.post(`${target.application}/delete`, 'owner', { confirmation: token });
    /** Refused, the application and its domain kept: no other one can claim the hostname. */
    const kept = async (
      target: { id: string; application: string },
      name: string,
      host: string,
    ) => {
      await remove(target, await issue(target, name))
        .expect(409)
        .expect((response) => {
          expect(response.body).toMatchObject({ code: 'application_cleanup_pending' });
        });
      await fixture
        .post(`${fixture.environment}/applications`, 'owner', {
          config: {
            version: 1,
            name: `${name}-claimer`,
            build: { type: 'image', image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
            run: { port: 3000 },
            domains: [host],
          },
        })
        .expect(409)
        .expect((response) => {
          expect(response.body).toMatchObject({ code: 'domain_taken' });
        });
      await fixture.get(target.application, 'owner').expect(200);
    };

    /** The removals the deletions asked for, oldest first. */
    const requested = async (applicationId: string) =>
      (
        await admin.query<{ id: string; kind: string; state: string; key: string }>(
          `SELECT id, kind, state, idempotency_key AS key FROM agent_actions
           WHERE application_id = $1 AND idempotency_key LIKE 'c:%' ORDER BY created_at, id`,
          [applicationId],
        )
      ).rows;

    it('asks the server to remove what it may hold, and deletes once it confirmed', async () => {
      const target = await failedFirst('leftover-api', 'leftover.example.com');
      // Its cleanup is still queued: nothing more is asked, the deletion waits.
      await kept(target, 'leftover-api', 'leftover.example.com');
      expect(await requested(target.id)).toEqual([]);
      // The cleanup failed: the deletion asks for the removal again, under a new key.
      await set(target.cleanup, 'failed');
      await kept(target, 'leftover-api', 'leftover.example.com');
      const first = await requested(target.id);
      expect(first).toMatchObject([{ kind: 'removeContainer', state: 'queued' }]);
      expect(first[0]?.key).toMatch(/^c:[0-9a-f-]{36}:remove:sk-[a-z0-9-]+$/);
      // While it is queued, a new attempt asks nothing more.
      await kept(target, 'leftover-api', 'leftover.example.com');
      expect(await requested(target.id)).toHaveLength(1);
      // It expired on the server: asked once more.
      await set(first[0]?.id ?? '', 'expired');
      await kept(target, 'leftover-api', 'leftover.example.com');
      const second = await requested(target.id);
      expect(second).toHaveLength(2);
      // Confirmed gone: the deletion goes through, and the domain is free.
      await set(second[1]?.id ?? '', 'succeeded');
      await remove(target, await issue(target, 'leftover-api')).expect(204);
      expect(await count('domains', target.id)).toBe(0);
      await create('leftover-api-claimer', 'leftover.example.com');
      const events = await auditLog().findMany({
        where: { targetId: target.id, action: 'application.cleanup_requested' },
      });
      expect(events).toHaveLength(2);
    });

    it('asks for the route removal when the last route change may still serve', async () => {
      const target = await failedFirst('routed-api', 'routed.example.com');
      await set(target.cleanup, 'succeeded');
      // A route the server installed, which no removal followed.
      await admin.query(
        `INSERT INTO agent_actions (id, organization_id, node_id, kind, idempotency_key, payload_enc,
           lease_epoch, deadline, state, attempts, application_id, deployment_id, created_at, updated_at)
         SELECT gen_random_uuid(), organization_id, node_id, 'upsertRoute',
           idempotency_key || '-route', payload_enc, lease_epoch, deadline, 'succeeded', 1,
           application_id, deployment_id, now(), now()
         FROM agent_actions WHERE id = $1`,
        [target.cleanup],
      );
      await kept(target, 'routed-api', 'routed.example.com');
      const asked = await requested(target.id);
      expect(asked).toMatchObject([{ kind: 'removeRoute', state: 'queued' }]);
      await set(asked[0]?.id ?? '', 'succeeded');
      await remove(target, await issue(target, 'routed-api')).expect(204);
    });

    it('asks for the removal of a created container that no removal confirmed', async () => {
      const target = await failedFirst('orphan-api', 'orphan.example.com');
      await admin.query('DELETE FROM agent_actions WHERE id = $1', [target.cleanup]);
      await kept(target, 'orphan-api', 'orphan.example.com');
      const asked = await requested(target.id);
      expect(asked).toMatchObject([{ kind: 'removeContainer' }]);
      await set(asked[0]?.id ?? '', 'succeeded');
      await remove(target, await issue(target, 'orphan-api')).expect(204);
      // A creation that never reached the server left nothing behind.
      const unsent = await failedFirst('unsent-api', 'unsent.example.com');
      await admin.query('DELETE FROM agent_actions WHERE id = $1', [unsent.cleanup]);
      await set(unsent.creation, 'expired', 0);
      await remove(unsent, await issue(unsent, 'unsent-api')).expect(204);
    });

    it('lets a removed server stop holding the deletion', async () => {
      const target = await failedFirst('stranded-api', 'stranded.example.com');
      await kept(target, 'stranded-api', 'stranded.example.com');
      const status = await admin.query<{ status: string }>(
        'SELECT status FROM nodes WHERE id = $1',
        [nodeId],
      );
      await admin.query("UPDATE nodes SET status = 'removed' WHERE id = $1", [nodeId]);
      try {
        await remove(target, await issue(target, 'stranded-api')).expect(204);
      } finally {
        await admin.query('UPDATE nodes SET status = $2 WHERE id = $1', [
          nodeId,
          status.rows[0]?.status,
        ]);
      }
    });
  });

  it('refuses an application whose first deployment is still queued', async () => {
    const { id } = await create('queued-api', 'queued.example.com');
    const application = `${fixture.environment}/applications/${id}`;
    await fixture.post(`${application}/deployments`, 'owner', {}).expect(201);
    const issued = (await confirmation('owner', id, 'queued-api').expect(201)).body as {
      token: string;
    };
    await fixture
      .post(`${application}/delete`, 'owner', { confirmation: issued.token })
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'deployment_in_progress' });
      });
    await fixture.get(application, 'owner').expect(200);
  });

  it('deletes an application that never ran', async () => {
    const { id } = await create('idle-api', 'idle.example.com');
    const issued = (await confirmation('owner', id, 'idle-api').expect(201)).body as {
      token: string;
    };
    await fixture
      .post(`${fixture.environment}/applications/${id}/delete`, 'owner', {
        confirmation: issued.token,
      })
      .expect(204);
    await fixture.get(`${fixture.environment}/applications/${id}`, 'owner').expect(404);
  });

  it('lets who may deploy stop an application, and never delete it', async () => {
    // In an unprotected environment a developer may deploy, and so stop. Deleting stays with
    // who administers the environment, whatever confirmation the developer holds.
    const environmentId = fixture.environment.split('/').at(-1);
    await admin.query('UPDATE environments SET protected = false WHERE id = $1', [environmentId]);
    try {
      const { id } = await create('shared-api', 'shared.example.com');
      const application = `${fixture.environment}/applications/${id}`;
      const deployed = (
        await fixture.post(`${application}/deployments`, 'environmentDeveloper', {}).expect(201)
      ).body as { deployment: { id: string } };
      await fixture.app
        .get(DeploymentPipeline)
        .run(fixture.organizationId, deployed.deployment.id, () => NOW);
      await admin.query(
        "UPDATE deployments SET state='succeeded', finished_at=$2, updated_at=$2 WHERE id=$1",
        [deployed.deployment.id, new Date(NOW.getTime() - 1000)],
      );
      const stopping = (
        await fixture.post(`${application}/stop`, 'environmentDeveloper', {}).expect(201)
      ).body as { id: string };
      await runToTheEnd(stopping.id);

      await confirmation('environmentDeveloper', id, 'shared-api').expect(404);
      const issued = (await confirmation('owner', id, 'shared-api').expect(201)).body as {
        token: string;
      };
      // Refused for the permission, before the confirmation is even looked at.
      await fixture
        .post(`${application}/delete`, 'environmentDeveloper', { confirmation: issued.token })
        .expect(404);
      await fixture.get(application, 'owner').expect(200);
      await fixture
        .post(`${application}/delete`, 'owner', { confirmation: issued.token })
        .expect(204);
    } finally {
      await admin.query('UPDATE environments SET protected = true WHERE id = $1', [environmentId]);
    }
  });
});
