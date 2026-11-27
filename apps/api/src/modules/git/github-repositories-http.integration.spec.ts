import { ServiceUnavailableException } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';
import { Client } from 'pg';

import { tenantHttpFixture } from '../../testing/tenant-http';

import {
  GITHUB_API,
  GITHUB_MANIFESTS,
  type GithubApi,
  type GithubManifests,
} from './application/ports';
import type { TokenScope } from './domain/github-api';

/** A key-shaped value that is no key, put together here so that no scanner reads the source as one. */
function fakePem(body: string): string {
  const armor = (edge: string, kind = 'PRIVATE') => `-----${edge} RSA ${kind} KEY-----`;
  return `${armor('BEGIN')}\n${body}\n${armor('END')}\n`;
}

const PEM = fakePem('MIIEfakeKeyMaterialForShipkeepTests==');
const APP_ID = 616161;

/** ADR 0031: the repositories an organization's App reaches, over HTTP, with a fake GitHub. */
describe('GitHub repositories over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let admin: Client;
  const keys: string[] = [];
  const scopes: { installationId: number; scope: TokenScope }[] = [];
  const revoked: string[] = [];
  const manifests: GithubManifests = {
    convert: () =>
      Promise.resolve({
        id: APP_ID,
        slug: 'shipkeep-repos-a1b2c3',
        name: 'Shipkeep repos a1b2c3',
        owner: { login: 'acme-corp' },
        client_id: 'Iv23liFakeRepos',
        client_secret: 'sk_test_fake_client_secret',
        webhook_secret: 'whsec_test_fake_webhook_secret',
        pem: PEM,
      }),
  };
  const github: GithubApi = {
    appJwt: (appId, privateKey) => {
      keys.push(privateKey.expose());
      return new Secret(`jwt-for-${String(appId)}`);
    },
    installationToken: (_jwt, installationId, scope) => {
      scopes.push({ installationId, scope });
      // Removed on GitHub, its delivery lost: GitHub refuses a token for it.
      if (installationId === 13) return Promise.reject(new ServiceUnavailableException());
      return Promise.resolve({
        token: new Secret(`ghs_token_for_${String(installationId)}`),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    },
    repositories: (_token, installationId) =>
      Promise.resolve({
        repositories: [
          {
            installationId,
            id: installationId * 10,
            fullName: `acme-corp/z-${String(installationId)}`,
            defaultBranch: 'main',
            private: true,
          },
          {
            installationId,
            id: installationId * 10 + 1,
            fullName: `acme-corp/a-${String(installationId)}`,
            defaultBranch: 'trunk',
            private: false,
          },
        ],
        truncated: false,
      }),
    branchHead: () => Promise.resolve(undefined),
    repository: () => Promise.resolve(undefined),
    file: () => Promise.resolve(undefined),
    revoke: (token) => {
      revoked.push(token.expose());
      return Promise.resolve(true);
    },
  };
  const path = () => `${fixture.root}/github-app/repositories`;

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

  it('lists nothing without an App, then the active installations, each with its own token', async () => {
    expect((await fixture.get(path(), 'owner').expect(200)).body).toEqual({
      repositories: [],
      truncated: false,
      unreachable: [],
    });
    const creation = await fixture
      .post(`${fixture.root}/github-app/manifests`, 'owner', { owner: 'user' })
      .expect(201);
    const state = new URL((creation.body as { url: string }).url).searchParams.get('state');
    await fixture.post(`${fixture.root}/github-app`, 'owner', { code: 'c', state }).expect(201);
    // Two installations reported by GitHub; the second is suspended.
    for (const [id, suspended] of [
      [11, false],
      [12, true],
    ] as const)
      await admin.query(
        `INSERT INTO github_installations (organization_id, installation_id, account_login, account_type,
           repository_selection, suspended_at, created_at, updated_at)
         VALUES ($1, $2, 'acme-corp', 'Organization', 'selected', $3, now(), now())`,
        [fixture.organizationId, id, suspended ? new Date() : null],
      );

    const listed = await fixture.get(path(), 'member').expect(200);
    expect(listed.body).toMatchObject({
      unreachable: [],
      repositories: [
        {
          installationId: 11,
          id: 111,
          fullName: 'acme-corp/a-11',
          defaultBranch: 'trunk',
          private: false,
        },
        {
          installationId: 11,
          id: 110,
          fullName: 'acme-corp/z-11',
          defaultBranch: 'main',
          private: true,
        },
      ],
      truncated: false,
    });
    // The App signed with its own key, asked metadata only, and gave the token back.
    expect(keys).toEqual([PEM]);
    expect(scopes).toEqual([{ installationId: 11, scope: { permissions: { metadata: 'read' } } }]);
    expect(revoked).toEqual(['ghs_token_for_11']);
    expect(JSON.stringify(listed.body)).not.toMatch(/ghs_|jwt-for|PRIVATE/);

    // The same listing again within a minute asks GitHub nothing.
    await fixture.get(path(), 'owner').expect(200);
    expect(scopes).toHaveLength(1);

    // An installation GitHub no longer answers for is reported, and hides nothing else.
    const add = (id: number) =>
      admin.query(
        `INSERT INTO github_installations (organization_id, installation_id, account_login, account_type,
           repository_selection, suspended_at, created_at, updated_at)
         VALUES ($1, $2, 'acme-corp', 'Organization', 'selected', NULL, now(), now())`,
        [fixture.organizationId, id],
      );
    await add(13);
    const partial = await fixture.get(path(), 'owner').expect(200);
    expect(partial.body).toMatchObject({ unreachable: [13] });
    expect((partial.body as { repositories: unknown[] }).repositories).toHaveLength(2);
    // When none answers, GitHub is unavailable.
    await admin.query(
      'DELETE FROM github_installations WHERE organization_id = $1 AND installation_id = 11',
      [fixture.organizationId],
    );
    await fixture.get(path(), 'owner').expect(503);
  });

  it('hides the list from someone outside the organization', async () => {
    await fixture.get(path(), 'outsider').expect(404);
  });
});
