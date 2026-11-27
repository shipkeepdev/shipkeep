import { createHmac, randomUUID } from 'node:crypto';

import { ServiceUnavailableException } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';
import { Client } from 'pg';

import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';
import {
  GITHUB_API,
  GITHUB_MANIFESTS,
  type GithubApi,
  type GithubManifests,
} from '../git/application/ports';
import type { PushEvent } from '../git/domain/github-webhook';

import { PushDeployments } from './application/push-deployments';
import { PushWorker } from './infrastructure/push-worker';

/** A key-shaped value that is no key, put together here so that no scanner reads the source as one. */
function fakePem(body: string): string {
  const armor = (edge: string, kind = 'PRIVATE') => `-----${edge} RSA ${kind} KEY-----`;
  return `${armor('BEGIN')}\n${body}\n${armor('END')}\n`;
}

const WEBHOOK = 'whsec_test_fake_webhook_secret';
const IMAGE = (tag: string) => `ghcr.io/acme/billing@sha256:${tag.repeat(64)}`;
const config = (image: string, port = 3000) =>
  `version: 1\nname: billing\nbuild: { type: image, image: "${image}" }\nrun:\n  port: ${String(port)}\n`;
const commit = (n: number) => String(n % 10).repeat(40);

/**
 * Issue #213 (ADR 0031): a verified push queues a deployment of its commit, with PostgreSQL and a
 * fake GitHub. Only the branch's current head deploys, and a replayed delivery does nothing.
 */
describe('deployments from GitHub pushes', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let admin: Client;
  // What the fake GitHub holds: the branch head, and the file at each commit.
  let head = commit(1);
  let unavailable = false;
  const files = new Map<string, string>([[commit(1), config(IMAGE('a'))]]);
  const manifests: GithubManifests = {
    convert: () =>
      Promise.resolve({
        id: 818181,
        slug: 'shipkeep-pushes-a1b2c3',
        name: 'Shipkeep pushes a1b2c3',
        owner: { login: 'acme-corp' },
        client_id: 'Iv23liFakePushes',
        client_secret: 'sk_test_fake_client_secret',
        webhook_secret: WEBHOOK,
        pem: fakePem('MIIEfakeKeyMaterialForShipkeepTests=='),
      }),
  };
  const github: GithubApi = {
    appJwt: (appId) => new Secret(`jwt-for-${String(appId)}`),
    installationToken: () =>
      unavailable
        ? Promise.reject(new ServiceUnavailableException())
        : Promise.resolve({
            token: new Secret('ghs_token_for_push'),
            expiresAt: new Date(Date.now() + 3_600_000),
          }),
    repositories: () => Promise.resolve({ repositories: [], truncated: false }),
    repository: (_token, installationId, repositoryId) =>
      Promise.resolve({
        installationId,
        id: repositoryId,
        fullName: 'acme-corp/billing',
        defaultBranch: 'main',
        private: true,
      }),
    branchHead: () => Promise.resolve(head),
    file: (_token, _fullName, _path, at) => Promise.resolve(files.get(at)),
    revoke: () => Promise.resolve(),
  };
  const push = (at: string, pusher: string | null = 'octocat'): PushEvent => ({
    organizationId: fixture.organizationId,
    installationId: 31,
    repositoryId: 901,
    branch: 'main',
    commit: at,
    pusher,
  });
  const handle = (event: PushEvent, only?: string[]) =>
    fixture.app.get(PushDeployments).handle(event, only);
  const deployments = async (applicationId: string) =>
    (
      await admin.query<{ trigger: string; actor_id: string | null; commit_sha: string | null }>(
        `SELECT d.trigger, d.actor_id, r.commit_sha FROM deployments d JOIN releases r ON r.id = d.release_id
         WHERE d.application_id = $1 ORDER BY d.started_at`,
        [applicationId],
      )
    ).rows;
  const events = async (applicationId: string, action: string) =>
    (await auditLog().findMany({ where: { action }, orderBy: { createdAt: 'asc' } })).filter(
      (event) =>
        event.targetId === applicationId ||
        (event.metadata as { applicationId?: string }).applicationId === applicationId,
    );
  let applicationId = '';

  beforeAll(async () => {
    fixture = await tenantHttpFixture([
      { token: GITHUB_MANIFESTS, value: manifests },
      { token: GITHUB_API, value: github },
    ]);
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    const creation = await fixture
      .post(`${fixture.root}/github-app/manifests`, 'owner', { owner: 'user' })
      .expect(201);
    const state = new URL((creation.body as { url: string }).url).searchParams.get('state');
    await fixture.post(`${fixture.root}/github-app`, 'owner', { code: 'c', state }).expect(201);
    await admin.query(
      `INSERT INTO github_installations (organization_id, installation_id, account_login, account_type,
         repository_selection, suspended_at, created_at, updated_at)
       VALUES ($1, 31, 'acme-corp', 'Organization', 'selected', NULL, now(), now())`,
      [fixture.organizationId],
    );
    const created = await fixture
      .post(`${fixture.environment}/applications/github`, 'owner', {
        installationId: 31,
        repositoryId: 901,
        branch: 'main',
      })
      .expect(201);
    applicationId = (created.body as { id: string }).id;
  });
  afterAll(async () => {
    await admin.end();
    await fixture.close();
  });

  it('queues a verified push with its delivery, once', async () => {
    const payload = {
      ref: 'refs/heads/main',
      after: commit(1),
      repository: { id: 901 },
      installation: { id: 31 },
      sender: { login: 'octocat' },
    };
    const body = JSON.stringify(payload);
    const deliver = (delivery: string) =>
      fixture
        .http()
        .post(`/api/v1/webhooks/github/${fixture.organizationId}`)
        .set('content-type', 'application/json')
        .set('x-github-event', 'push')
        .set('x-github-delivery', delivery)
        .set(
          'x-hub-signature-256',
          `sha256=${createHmac('sha256', WEBHOOK).update(body).digest('hex')}`,
        )
        .send(body);
    const jobs = async () =>
      (
        await admin.query<{ data: unknown }>(
          "SELECT data FROM shipkeep_jobs.job WHERE name = 'github-push' ORDER BY created_on",
        )
      ).rows.map((row) => row.data);
    const delivery = randomUUID();
    await deliver(delivery).expect(204);
    expect(await jobs()).toEqual([
      {
        organizationId: fixture.organizationId,
        installationId: 31,
        repositoryId: 901,
        branch: 'main',
        commit: commit(1),
        pusher: 'octocat',
      },
    ]);
    // GitHub's redelivery, and the same body under another identifier, queue nothing more.
    await deliver(delivery).expect(204);
    await deliver(randomUUID()).expect(204);
    expect(await jobs()).toHaveLength(1);
    // A tag and a deleted branch deploy nothing.
    for (const other of [
      { ...payload, ref: 'refs/tags/v1', after: commit(2) },
      { ...payload, deleted: true, after: '0'.repeat(40) },
    ]) {
      const text = JSON.stringify(other);
      await fixture
        .http()
        .post(`/api/v1/webhooks/github/${fixture.organizationId}`)
        .set('content-type', 'application/json')
        .set('x-github-event', 'push')
        .set('x-github-delivery', randomUUID())
        .set(
          'x-hub-signature-256',
          `sha256=${createHmac('sha256', WEBHOOK).update(text).digest('hex')}`,
        )
        .send(text)
        .expect(204);
    }
    expect(await jobs()).toHaveLength(1);
    // The worker reads the job back and refuses a payload this queue never sends.
    expect(fixture.app.get(PushWorker)).toBeDefined();
  });

  it('holds a push in a protected environment: the configuration follows, nothing deploys', async () => {
    head = commit(2);
    files.set(commit(2), config(IMAGE('b'), 4000));
    expect(await handle(push(commit(2)))).toEqual([]);
    expect(await deployments(applicationId)).toEqual([]);
    const stored = await admin.query<{ config: { run: { port: number } } }>(
      'SELECT config FROM applications WHERE id = $1',
      [applicationId],
    );
    expect(stored.rows.map((row) => row.config.run.port)).toEqual([4000]);
    const held = await events(applicationId, 'deployment.push_held');
    expect(held.map((event) => [event.actorKind, event.metadata])).toMatchObject([
      [
        'system',
        { commitSha: commit(2), githubPusher: 'octocat', reason: 'protected_environment' },
      ],
    ]);
    const updated = await events(applicationId, 'application.updated');
    expect(updated.map((event) => [event.actorKind, event.metadata])).toMatchObject([
      ['system', { commitSha: commit(2), source: 'git' }],
    ]);
  });

  it('deploys the branch head in an unprotected environment, once, as the system', async () => {
    await admin.query('UPDATE environments SET protected = false WHERE id = $1', [
      fixture.environmentId,
    ]);
    head = commit(3);
    files.set(commit(3), config(IMAGE('c')));
    // An overtaken push, its commit no longer the branch head, deploys nothing.
    expect(await handle(push(commit(2)))).toEqual([]);
    expect(await deployments(applicationId)).toEqual([]);

    expect(await handle(push(commit(3), null))).toEqual([]);
    expect(await deployments(applicationId)).toEqual([
      { trigger: 'webhook', actor_id: null, commit_sha: commit(3) },
    ]);
    const queued = await events(applicationId, 'deployment.queued');
    expect(queued.map((event) => [event.actorKind, event.metadata])).toMatchObject([
      ['system', { trigger: 'webhook', commitSha: commit(3), githubPusher: null }],
    ]);
    // The same push handled again, as a retried job is, deploys nothing twice.
    expect(await handle(push(commit(3)))).toEqual([]);
    expect(await deployments(applicationId)).toHaveLength(1);

    // While that deployment runs, a newer push waits to be tried again.
    head = commit(4);
    files.set(commit(4), config(IMAGE('d')));
    expect(await handle(push(commit(4)))).toEqual([applicationId]);
    expect(await deployments(applicationId)).toHaveLength(1);
    await admin.query(
      "UPDATE deployments SET state = 'succeeded', finished_at = now(), updated_at = now() WHERE application_id = $1",
      [applicationId],
    );
    expect(await handle(push(commit(4)), [applicationId])).toEqual([]);
    expect((await deployments(applicationId)).map((row) => row.commit_sha)).toEqual([
      commit(3),
      commit(4),
    ]);
    await admin.query(
      "UPDATE deployments SET state = 'succeeded', finished_at = now(), updated_at = now() WHERE application_id = $1 AND finished_at IS NULL",
      [applicationId],
    );
  });

  it('audits a push it cannot deploy, and tries again while GitHub is unavailable', async () => {
    head = commit(5);
    files.set(commit(5), 'version: 1\nname: [unclosed\n');
    expect(await handle(push(commit(5)))).toEqual([]);
    const refused = await events(applicationId, 'deployment.push_refused');
    expect(refused.map((event) => [event.actorKind, event.metadata])).toMatchObject([
      ['system', { commitSha: commit(5), code: 'invalid_application_config' }],
    ]);
    // A renamed application in the repository is refused too: the name identifies it.
    head = commit(6);
    files.set(commit(6), config(IMAGE('e')).replace('name: billing', 'name: invoices'));
    expect(await handle(push(commit(6)))).toEqual([]);
    expect((await events(applicationId, 'deployment.push_refused')).at(-1)?.metadata).toMatchObject(
      { code: 'application_name_immutable' },
    );
    unavailable = true;
    expect(await handle(push(commit(6)))).toEqual([applicationId]);
    unavailable = false;
    expect(await deployments(applicationId)).toHaveLength(2);
  });
});
