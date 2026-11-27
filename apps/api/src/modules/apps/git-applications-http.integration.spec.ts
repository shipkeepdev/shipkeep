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
import type { TokenScope } from '../git/domain/github-api';

/** A key-shaped value that is no key, put together here so that no scanner reads the source as one. */
function fakePem(body: string): string {
  const armor = (edge: string, kind = 'PRIVATE') => `-----${edge} RSA ${kind} KEY-----`;
  return `${armor('BEGIN')}\n${body}\n${armor('END')}\n`;
}

const HEAD = 'a'.repeat(40);
const IMAGE = `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}`;
const config = (build: string) =>
  `version: 1\nname: billing\nbuild: ${build}\nrun:\n  port: 3000\ndomains: [billing-git.example.com]\n`;

/**
 * Issue #213 (ADR 0031): an application whose configuration is the shipkeep.yml of a GitHub
 * repository, created over HTTP with PostgreSQL and a fake GitHub.
 */
describe('applications from a GitHub repository over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let admin: Client;
  const scopes: { installationId: number; scope: TokenScope }[] = [];
  const revoked: string[] = [];
  const read: string[] = [];
  const manifests: GithubManifests = {
    convert: () =>
      Promise.resolve({
        id: 717171,
        slug: 'shipkeep-sources-a1b2c3',
        name: 'Shipkeep sources a1b2c3',
        owner: { login: 'acme-corp' },
        client_id: 'Iv23liFakeSources',
        client_secret: 'sk_test_fake_client_secret',
        webhook_secret: 'whsec_test_fake_webhook_secret',
        pem: fakePem('MIIEfakeKeyMaterialForShipkeepTests=='),
      }),
  };
  const files: Record<string, string> = {
    'shipkeep.yml': config(`{ type: image, image: "${IMAGE}" }`),
    'bad.yml': 'version: 1\nname: [unclosed\n',
  };
  const github: GithubApi = {
    appJwt: (appId) => new Secret(`jwt-for-${String(appId)}`),
    installationToken: (_jwt, installationId, scope) => {
      // GitHub refuses a token for a repository the installation does not include.
      if (scope.repositoryIds?.includes(998)) return Promise.resolve(undefined);
      scopes.push({ installationId, scope });
      return Promise.resolve({
        token: new Secret(`ghs_token_${String(scopes.length)}`),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    },
    repositories: () => Promise.resolve({ repositories: [], truncated: false }),
    // Renamed on GitHub since it was chosen: the identifier is what counts.
    repository: (_token, installationId, repositoryId) =>
      Promise.resolve(
        repositoryId === 501
          ? {
              installationId,
              id: 501,
              fullName: 'acme-corp/billing-renamed',
              defaultBranch: 'main',
              private: true,
            }
          : undefined,
      ),
    branchHead: (_token, _fullName, branch) =>
      Promise.resolve(branch === 'main' ? HEAD : undefined),
    file: (_token, fullName, path, commit) => {
      read.push(`${fullName}:${path}@${commit}`);
      return Promise.resolve(files[path]);
    },
    revoke: (token) => {
      revoked.push(token.expose());
      return Promise.resolve();
    },
  };
  const create = (body: Record<string, unknown>, actor: 'owner' | 'outsider' = 'owner') =>
    fixture.post(`${fixture.environment}/applications/github`, actor, {
      installationId: 21,
      repositoryId: 501,
      branch: 'main',
      ...body,
    });
  const refused = async (body: Record<string, unknown>, status: number, code: string) => {
    const response = await create(body).expect(status);
    expect(response.body).toMatchObject({ code });
    return response.body as Record<string, unknown>;
  };

  beforeAll(async () => {
    fixture = await tenantHttpFixture([
      { token: GITHUB_MANIFESTS, value: manifests },
      { token: GITHUB_API, value: github },
    ]);
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
  });
  afterAll(async () => {
    await admin.end();
    await fixture.close();
  });

  it('reads shipkeep.yml at the branch head through the App, and refuses what it cannot use', async () => {
    // No App yet.
    await refused({}, 409, 'github_app_missing');
    const creation = await fixture
      .post(`${fixture.root}/github-app/manifests`, 'owner', { owner: 'user' })
      .expect(201);
    const state = new URL((creation.body as { url: string }).url).searchParams.get('state');
    await fixture.post(`${fixture.root}/github-app`, 'owner', { code: 'c', state }).expect(201);
    for (const [id, suspended] of [
      [21, false],
      [22, true],
    ] as const)
      await admin.query(
        `INSERT INTO github_installations (organization_id, installation_id, account_login, account_type,
           repository_selection, suspended_at, created_at, updated_at)
         VALUES ($1, $2, 'acme-corp', 'Organization', 'selected', $3, now(), now())`,
        [fixture.organizationId, id, suspended ? new Date() : null],
      );

    // Refused before GitHub is asked: names a URL would resolve elsewhere, a suspended installation.
    await refused({ configPath: '../shipkeep.yml' }, 400, 'invalid_config_path');
    await refused({ configPath: 'shipkeep.json' }, 400, 'invalid_config_path');
    await refused({ branch: 'main..dev' }, 400, 'invalid_branch');
    await refused({ installationId: 22 }, 400, 'github_installation_unavailable');
    await refused({ installationId: 23 }, 400, 'github_installation_unavailable');
    expect(scopes).toEqual([]);
    // Without deploy.run in the environment, nothing is read either.
    await create({}, 'outsider').expect(404);
    expect(scopes).toEqual([]);

    // Refused from GitHub's answers, each token given back.
    await refused({ repositoryId: 999 }, 400, 'github_repository_unavailable');
    await refused({ repositoryId: 998 }, 400, 'github_repository_unavailable');
    await refused({ branch: 'gone' }, 400, 'github_branch_not_found');
    await refused({ configPath: 'missing.yml' }, 400, 'github_config_not_found');
    const invalid = await refused({ configPath: 'bad.yml' }, 400, 'invalid_application_config');
    expect(invalid).toMatchObject({ details: { commit: HEAD } });
    expect(revoked).toHaveLength(scopes.length);

    const created = await create({}).expect(201);
    const app = created.body as {
      id: string;
      source: string;
      repository: unknown;
      config: { build: { image: string } };
      configSha: string;
    };
    expect(app).toMatchObject({
      source: 'git',
      repository: {
        installationId: 21,
        repositoryId: 501,
        fullName: 'acme-corp/billing-renamed',
        branch: 'main',
        configPath: 'shipkeep.yml',
        commitSha: HEAD,
      },
      config: { name: 'billing', build: { type: 'image', image: IMAGE } },
    });
    // One repository, its contents read only, and the token revoked once read.
    expect(scopes.at(-1)).toEqual({
      installationId: 21,
      scope: { repositoryIds: [501], permissions: { contents: 'read', metadata: 'read' } },
    });
    expect(revoked).toHaveLength(scopes.length);
    expect(read.at(-1)).toBe(`acme-corp/billing-renamed:shipkeep.yml@${HEAD}`);
    expect(JSON.stringify(created.body)).not.toMatch(/ghs_|jwt-for|PRIVATE/);
    // The domain is claimed, as for any application.
    const domains = await fixture
      .get(`${fixture.environment}/applications/${app.id}/domains`, 'owner')
      .expect(200);
    expect(domains.body).toMatchObject({ items: [{ hostname: 'billing-git.example.com' }] });

    const events = await auditLog().findMany({
      where: { action: 'application.created', targetId: app.id },
    });
    expect(events.map((event) => event.metadata)).toMatchObject([
      {
        name: 'billing',
        source: 'git',
        repository: 'acme-corp/billing-renamed',
        repositoryId: 501,
        branch: 'main',
        configPath: 'shipkeep.yml',
        commitSha: HEAD,
        configSha: app.configSha,
      },
    ]);

    // Its configuration is the repository's: the API does not replace it.
    await fixture
      .post(`${fixture.environment}/applications/${app.id}/config`, 'owner', {
        expectedConfigSha: app.configSha,
        config: { ...app.config, run: { port: 4000 } },
      })
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'application_config_in_repository' });
      });
    // And an environment holding it cannot be cloned yet.
    await fixture
      .post(`${fixture.environment}/clone`, 'owner', { name: 'staging-copy' })
      .expect(409)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'environment_has_git_applications' });
      });
    const stored = await admin.query<{
      installation_id: string;
      repository: string;
      commit_sha: string;
    }>('SELECT installation_id::text, repository, commit_sha FROM applications WHERE id = $1', [
      app.id,
    ]);
    expect(stored.rows).toEqual([
      { installation_id: '21', repository: 'acme-corp/billing-renamed', commit_sha: HEAD },
    ]);
  });

  it('keeps every repository column of a Git application set, and none of an image one', async () => {
    const insert = (source: string, installation: number | null, repositoryId: number | null) =>
      admin.query(
        `INSERT INTO applications (id, organization_id, project_id, environment_id, name, source,
           installation_id, repository_id, repository, branch, config_path, commit_sha, config,
           config_sha, created_at, updated_at)
         SELECT gen_random_uuid(), organization_id, project_id, id, 'check-' || $1, $1, $2, $3,
           CASE WHEN $3::bigint IS NULL THEN NULL ELSE 'acme-corp/x' END,
           CASE WHEN $3::bigint IS NULL THEN NULL ELSE 'main' END,
           CASE WHEN $3::bigint IS NULL THEN NULL ELSE 'shipkeep.yml' END,
           CASE WHEN $3::bigint IS NULL THEN NULL ELSE repeat('a', 40) END,
           '{}', repeat('0', 64), now(), now()
         FROM environments WHERE id = $4`,
        [source, installation, repositoryId, fixture.environmentId],
      );
    // A Git application without its installation, an image one with a repository.
    await expect(insert('git', null, 1)).rejects.toThrow(/applications_git_source_check/);
    await expect(insert('image', 1, 1)).rejects.toThrow(/applications_git_source_check/);
    await expect(insert('compose', null, null)).rejects.toThrow(/applications_source_check/);
  });
});
