import { fromBinary } from '@bufbuild/protobuf';
import { Secret } from '@shipkeep/domain';
import { ActionRequestSchema, BuildType } from '@shipkeep/proto-ts';
import { Client } from 'pg';

import { AppConfig } from '../../platform/config/app-config';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { auditLog } from '../../testing/audit-log';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { AGENT_ACTION_STORE, type AgentActionStore } from '../fleet/application/ports';
import {
  GITHUB_API,
  GITHUB_MANIFESTS,
  type GithubApi,
  type GithubManifests,
} from '../git/application/ports';

import { DeploymentPipeline } from './application/deployment-pipeline';
import { noGithubWrites } from '../../testing/github-writes';

/** A key-shaped value that is no key, put together here so that no scanner reads the source as one. */
function fakePem(body: string): string {
  const armor = (edge: string, kind = 'PRIVATE') => `-----${edge} RSA ${kind} KEY-----`;
  return `${armor('BEGIN')}\n${body}\n${armor('END')}\n`;
}

const HEAD = 'a'.repeat(40);
const BUILT = `sha256:${'b'.repeat(64)}`;
const TOKEN = 'ghs_fake_build_token_for_the_test';
const CONFIG = `version: 1
name: built-api
build:
  type: dockerfile
  context: ./services/api
  args:
    NODE_ENV: production
run:
  port: 3000
`;
/** The configuration GitHub serves: a Dockerfile build, or another one a test asks for. */
let served = CONFIG;
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/**
 * ADR 0030 with PostgreSQL and a fake GitHub: a Git application with a Dockerfile is built on the
 * server of its first replica, at its commit, then pulled from the installation's registry with a
 * grant that only pulls.
 */
describe('deployments built from a repository', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let admin: Client;
  let nodeId = '';
  const minted: string[] = [];
  /** The tokens revoked through GitHub, as it received them. */
  const revoked: string[] = [];
  /** Whether GitHub answers a revocation; and the token it mints next, and what runs then. */
  let revocations = true;
  let nextToken = () => TOKEN;
  let onMint: (() => Promise<void>) | undefined;
  const manifests: GithubManifests = {
    convert: () =>
      Promise.resolve({
        id: 919191,
        slug: 'shipkeep-builds-a1b2c3',
        name: 'Shipkeep builds a1b2c3',
        owner: { login: 'acme-corp' },
        client_id: 'Iv23liFakeBuilds',
        client_secret: 'sk_test_fake_client_secret',
        webhook_secret: 'whsec_test_fake_webhook_secret',
        pem: fakePem('MIIEfakeKeyMaterialForShipkeepTests=='),
      }),
  };
  const github: GithubApi = {
    appJwt: (appId) => new Secret(`jwt-for-${String(appId)}`),
    installationToken: async (_jwt, _installation, scope) => {
      minted.push(JSON.stringify(scope));
      const token = nextToken();
      const hook = onMint;
      onMint = undefined;
      await hook?.();
      return { token: new Secret(token), expiresAt: new Date(Date.now() + 3_600_000) };
    },
    repositories: () => Promise.resolve({ repositories: [], truncated: false }),
    repository: (_token, installationId, repositoryId) =>
      Promise.resolve({
        installationId,
        id: repositoryId,
        fullName: 'acme-corp/built-api',
        defaultBranch: 'main',
        private: true,
      }),
    branchHead: () => Promise.resolve(HEAD),
    file: () => Promise.resolve(served),
    ...noGithubWrites,
    revoke: (token) => {
      if (!revocations) return Promise.resolve(false);
      revoked.push(token.expose());
      return Promise.resolve(true);
    },
  };

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
       VALUES ($1, 41, 'acme-corp', 'Organization', 'selected', NULL, now(), now())`,
      [fixture.organizationId],
    );
    nodeId = await enrollTestNode(fixture, {
      facts: {
        hostname: 'builder.example.com',
        architecture: 'amd64',
        cpu_count: 2,
        memory_bytes: 2 ** 32,
      },
      heartbeatAt: new Date(),
    });
  });
  afterAll(async () => {
    await admin.end();
    await fixture.close();
  });

  const queued = async (key: string, node = nodeId) => {
    const stored = await fixture.app
      .get(PrismaUnitOfWork)
      .runTenant(fixture.organizationId, () =>
        fixture.app
          .get<AgentActionStore>(AGENT_ACTION_STORE)
          .findByKey(fixture.organizationId, node, key),
      );
    return stored ? fromBinary(ActionRequestSchema, stored.payload).action : undefined;
  };
  const token = (username: string, password: string, scope: string) =>
    fixture
      .http()
      .get(`/api/v1/registry/token?${new URLSearchParams({ service: host(), scope }).toString()}`)
      .set('authorization', basic(username, password))
      .expect(200);
  const host = () => new URL(fixture.app.get(AppConfig).get('API_PUBLIC_URL')).host;
  const access = (answer: { body: unknown }) =>
    (
      JSON.parse(
        Buffer.from(
          (answer.body as { token: string }).token.split('.')[1] ?? '',
          'base64url',
        ).toString(),
      ) as { access: unknown }
    ).access;

  it('builds at the commit on the first replica, then pulls the pushed digest with a pull grant', async () => {
    const created = await fixture
      .post(`${fixture.environment}/applications/github`, 'owner', {
        installationId: 41,
        repositoryId: 777,
        branch: 'main',
      })
      .expect(201);
    const applicationId = (created.body as { id: string }).id;
    const deployed = await fixture
      .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
      .expect(201);
    const { release, deployment } = deployed.body as {
      release: { id: string; image: string };
      deployment: { id: string };
    };
    const repository = `${host()}/${fixture.organizationId}/${applicationId}`;
    expect(release.image).toBe(`${repository}:1`);

    const pipeline = fixture.app.get(DeploymentPipeline);
    await pipeline.run(fixture.organizationId, deployment.id);
    const build = await queued(`d:${deployment.id}:build`);
    if (build?.case !== 'buildImage') throw new Error('no build was queued');
    expect(build.value).toMatchObject({
      repoUrl: 'https://github.com/acme-corp/built-api.git',
      commitSha: HEAD,
      gitToken: TOKEN,
      context: 'services/api',
      dockerfile: 'Dockerfile',
      args: { NODE_ENV: 'production' },
      targetRef: `${repository}:1`,
      pushCredentials: { server: host() },
    });
    // The token reads that one repository's contents, nothing else.
    expect(minted.at(-1)).toBe(
      JSON.stringify({ repositoryIds: [777], permissions: { contents: 'read', metadata: 'read' } }),
    );
    // The build's grant pushes to the application's repository, and only there.
    const push = build.value.pushCredentials;
    if (!push) throw new Error('no push credentials');
    expect(
      access(
        await token(
          push.username,
          push.password,
          `repository:${fixture.organizationId}/${applicationId}:pull,push`,
        ),
      ),
    ).toEqual([
      {
        type: 'repository',
        name: `${fixture.organizationId}/${applicationId}`,
        actions: ['pull', 'push'],
      },
    ]);
    // Nothing else is queued while the build runs, and its token is not revoked meanwhile.
    const others = await admin.query('SELECT 1 FROM agent_actions WHERE deployment_id = $1', [
      deployment.id,
    ]);
    expect(others.rowCount).toBe(1);
    const before = revoked.length;
    await pipeline.run(fixture.organizationId, deployment.id);
    expect(revoked.length).toBe(before);

    // The agent answers the digest it pushed.
    await admin.query(
      `UPDATE agent_actions SET state = 'succeeded', result = $2, completed_at = now(), updated_at = now()
       WHERE deployment_id = $1 AND idempotency_key = $3`,
      [
        deployment.id,
        JSON.stringify({ buildImage: { imageDigest: BUILT } }),
        `d:${deployment.id}:build`,
      ],
    );
    await pipeline.run(fixture.organizationId, deployment.id);
    const recorded = await admin.query<{ image_digest: string }>(
      'SELECT image_digest FROM releases WHERE id = $1',
      [release.id],
    );
    expect(recorded.rows).toEqual([{ image_digest: BUILT }]);
    const built = await auditLog().findMany({
      where: { action: 'release.image_built', targetId: release.id },
    });
    expect(built.map((event) => event.metadata)).toMatchObject([
      { digest: BUILT, commitSha: HEAD },
    ]);
    // The build has ended: its token is revoked once, taken out of the action, and audited.
    expect(revoked.slice(before)).toEqual([TOKEN]);
    const after = await queued(`d:${deployment.id}:build`);
    if (after?.case !== 'buildImage') throw new Error('the build action is gone');
    expect(after.value.gitToken).toBe('');
    expect(after.value.repoUrl).toBe('https://github.com/acme-corp/built-api.git');
    const revocations = await auditLog().findMany({
      where: { action: 'deployment.build_token_revoked', targetId: deployment.id },
    });
    expect(revocations).toHaveLength(1);
    await pipeline.run(fixture.organizationId, deployment.id);
    expect(revoked.slice(before)).toEqual([TOKEN]);

    // Then the replicas pull that digest from the installation's registry, with a pull grant,
    // once the agent has made their network.
    await admin.query(
      `UPDATE agent_actions SET state = 'succeeded', completed_at = now(), updated_at = now()
       WHERE deployment_id = $1 AND state = 'queued'`,
      [deployment.id],
    );
    await pipeline.run(fixture.organizationId, deployment.id);
    const pull = await queued(`d:${deployment.id}:pull:${nodeId}`);
    if (pull?.case !== 'pullImage') throw new Error('no pull was queued');
    expect(pull.value.imageRef).toBe(`${repository}@${BUILT}`);
    const credentials = pull.value.registryCredentials;
    if (!credentials) throw new Error('no pull credentials');
    expect(credentials.server).toBe(host());
    expect(
      access(
        await token(
          credentials.username,
          credentials.password,
          `repository:${fixture.organizationId}/${applicationId}:pull,push`,
        ),
      ),
    ).toEqual([
      { type: 'repository', name: `${fixture.organizationId}/${applicationId}`, actions: ['pull'] },
    ]);
    // Two grants, each audited: the build's, which pushes, and the servers', which only pull.
    const grants = await auditLog().findMany({
      where: { action: 'registry.grant_issued', targetId: applicationId },
    });
    expect(grants.map((event) => (event.metadata as { push: boolean }).push).sort()).toEqual([
      false,
      true,
    ]);
    // The token never reaches the audit log.
    expect(
      JSON.stringify(await auditLog().findMany({ where: { targetId: applicationId } })),
    ).not.toContain(TOKEN);
  });

  it('asks the server to build with Nixpacks, with no Dockerfile', async () => {
    served =
      'version: 1\nname: nixpacks-api\nbuild:\n  type: nixpacks\n  context: ./web/\nrun:\n  port: 3000\n';
    try {
      const created = await fixture
        .post(`${fixture.environment}/applications/github`, 'owner', {
          installationId: 41,
          repositoryId: 778,
          branch: 'main',
        })
        .expect(201);
      const applicationId = (created.body as { id: string }).id;
      const deployed = await fixture
        .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
        .expect(201);
      const { deployment } = deployed.body as { deployment: { id: string } };
      await fixture.app.get(DeploymentPipeline).run(fixture.organizationId, deployment.id);
      const build = await queued(`d:${deployment.id}:build`);
      if (build?.case !== 'buildImage') throw new Error('no build was queued');
      expect(build.value).toMatchObject({
        buildType: BuildType.NIXPACKS,
        context: 'web',
        dockerfile: '',
        commitSha: HEAD,
        targetRef: `${host()}/${fixture.organizationId}/${applicationId}:1`,
      });
    } finally {
      served = CONFIG;
    }
  });

  it('revokes the token of a build that failed, as the deployment fails', async () => {
    served = CONFIG.replace('name: built-api', 'name: failed-api');
    // A server of its own: the other tests' replicas fill the first one.
    const builder = await enrollTestNode(fixture, {
      facts: {
        hostname: 'builder-2.example.com',
        architecture: 'amd64',
        cpu_count: 2,
        memory_bytes: 2 ** 32,
      },
      heartbeatAt: new Date(),
    });
    try {
      const created = await fixture
        .post(`${fixture.environment}/applications/github`, 'owner', {
          installationId: 41,
          repositoryId: 779,
          branch: 'main',
        })
        .expect(201);
      const applicationId = (created.body as { id: string }).id;
      const deployed = await fixture
        .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
        .expect(201);
      const { deployment } = deployed.body as { deployment: { id: string } };
      const pipeline = fixture.app.get(DeploymentPipeline);
      await pipeline.run(fixture.organizationId, deployment.id);
      const before = revoked.length;
      await admin.query(
        `UPDATE agent_actions SET state = 'failed', completed_at = now(), updated_at = now()
       WHERE deployment_id = $1 AND idempotency_key = $2`,
        [deployment.id, `d:${deployment.id}:build`],
      );
      await pipeline.run(fixture.organizationId, deployment.id);
      const state = await admin.query<{ state: string }>(
        'SELECT state FROM deployments WHERE id = $1',
        [deployment.id],
      );
      expect(state.rows).toEqual([{ state: 'failed' }]);
      expect(revoked.slice(before)).toEqual([TOKEN]);
      const after = await queued(`d:${deployment.id}:build`, builder);
      if (after?.case !== 'buildImage') throw new Error('the build action is gone');
      expect(after.value.gitToken).toBe('');
    } finally {
      served = CONFIG;
    }
  });

  /** A Git application of its own, on a server of its own, deployed and its run started. */
  const deployedApplication = async (name: string, repositoryId: number, hostname: string) => {
    served = CONFIG.replace('name: built-api', `name: ${name}`);
    await enrollTestNode(fixture, {
      facts: { hostname, architecture: 'amd64', cpu_count: 2, memory_bytes: 2 ** 32 },
      heartbeatAt: new Date(),
    });
    try {
      const created = await fixture
        .post(`${fixture.environment}/applications/github`, 'owner', {
          installationId: 41,
          repositoryId,
          branch: 'main',
        })
        .expect(201);
      const applicationId = (created.body as { id: string }).id;
      const deployed = await fixture
        .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
        .expect(201);
      return {
        deploymentId: (deployed.body as { deployment: { id: string } }).deployment.id,
      };
    } finally {
      served = CONFIG;
    }
  };
  /** A deployment's build action, wherever placement put it. */
  const build = async (deploymentId: string) => {
    const key = `d:${deploymentId}:build`;
    const found = await admin.query<{ node_id: string }>(
      'SELECT node_id FROM agent_actions WHERE idempotency_key = $1',
      [key],
    );
    const node = found.rows.at(0)?.node_id;
    return node ? queued(key, node) : undefined;
  };
  const endBuild = (deploymentId: string) =>
    admin.query(
      `UPDATE agent_actions SET state = 'failed', completed_at = now(), updated_at = now()
       WHERE deployment_id = $1 AND idempotency_key = $2`,
      [deploymentId, `d:${deploymentId}:build`],
    );

  it('keeps a token GitHub could not revoke, asks again, and clears one that has expired', async () => {
    const pipeline = fixture.app.get(DeploymentPipeline);
    const first = await deployedApplication('retried-api', 780, 'builder-3.example.com');
    await pipeline.run(fixture.organizationId, first.deploymentId);
    await endBuild(first.deploymentId);
    revocations = false;
    try {
      // GitHub does not answer: the token stays in the action, and the run asks to come back.
      expect(await pipeline.run(fixture.organizationId, first.deploymentId)).toBe('wait');
      const kept = await build(first.deploymentId);
      if (kept?.case !== 'buildImage') throw new Error('the build action is gone');
      expect(kept.value.gitToken).toBe(TOKEN);
      expect(
        await auditLog().count({
          where: { action: 'deployment.build_token_revoked', targetId: first.deploymentId },
        }),
      ).toBe(0);
      // An hour later the token has expired by itself: it is cleared without GitHub.
      await admin.query(
        `UPDATE agent_actions SET created_at = now() - interval '71 minutes'
         WHERE idempotency_key = $1`,
        [`d:${first.deploymentId}:build`],
      );
      expect(await pipeline.run(fixture.organizationId, first.deploymentId)).toBe('done');
      const cleared = await build(first.deploymentId);
      if (cleared?.case !== 'buildImage') throw new Error('the build action is gone');
      expect(cleared.value.gitToken).toBe('');
      const events = await auditLog().findMany({
        where: { action: 'deployment.build_token_revoked', targetId: first.deploymentId },
      });
      expect(events.map((event) => event.metadata)).toMatchObject([{ ended: 'expiry' }]);
    } finally {
      revocations = true;
    }

    // GitHub answers again: the next run revokes the token, then clears it.
    const second = await deployedApplication('recovered-api', 781, 'builder-4.example.com');
    await pipeline.run(fixture.organizationId, second.deploymentId);
    await endBuild(second.deploymentId);
    revocations = false;
    expect(await pipeline.run(fixture.organizationId, second.deploymentId)).toBe('wait');
    revocations = true;
    const before = revoked.length;
    expect(await pipeline.run(fixture.organizationId, second.deploymentId)).toBe('done');
    expect(revoked.slice(before)).toEqual([TOKEN]);
    const events = await auditLog().findMany({
      where: { action: 'deployment.build_token_revoked', targetId: second.deploymentId },
    });
    expect(events.map((event) => event.metadata)).toMatchObject([{ ended: 'github' }]);
  });

  it('revokes at once a token minted for a build another run queued first', async () => {
    const pipeline = fixture.app.get(DeploymentPipeline);
    const { deploymentId } = await deployedApplication('raced-api', 782, 'builder-5.example.com');
    const unused = 'ghs_fake_token_minted_for_nothing';
    // While this run mints its token, another run mints one and queues the build with it.
    nextToken = () => unused;
    onMint = async () => {
      nextToken = () => TOKEN;
      await pipeline.run(fixture.organizationId, deploymentId);
    };
    const before = revoked.length;
    try {
      await pipeline.run(fixture.organizationId, deploymentId);
    } finally {
      nextToken = () => TOKEN;
      onMint = undefined;
    }
    expect(revoked.slice(before)).toEqual([unused]);
    // The build carries the other run's token, which stays until the build ends.
    const queuedBuild = await build(deploymentId);
    if (queuedBuild?.case !== 'buildImage') throw new Error('no build was queued');
    expect(queuedBuild.value.gitToken).toBe(TOKEN);
  });
});
