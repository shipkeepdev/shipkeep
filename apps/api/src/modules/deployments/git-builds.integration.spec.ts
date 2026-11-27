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
    installationToken: (_jwt, _installation, scope) => {
      minted.push(JSON.stringify(scope));
      return Promise.resolve({
        token: new Secret(TOKEN),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
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
    revoke: () => Promise.resolve(),
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

  const queued = async (key: string) => {
    const stored = await fixture.app
      .get(PrismaUnitOfWork)
      .runTenant(fixture.organizationId, () =>
        fixture.app
          .get<AgentActionStore>(AGENT_ACTION_STORE)
          .findByKey(fixture.organizationId, nodeId, key),
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
    // Nothing else is queued while the build runs.
    const others = await admin.query('SELECT 1 FROM agent_actions WHERE deployment_id = $1', [
      deployment.id,
    ]);
    expect(others.rowCount).toBe(1);

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
});
