import { createHash } from 'node:crypto';

import { Secret } from '@shipkeep/domain';
import { MAX_CONFIG_BYTES } from '@shipkeep/config-schema';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { parse } from 'yaml';

import { auditLog } from '../../testing/audit-log';
import { AppConfig } from '../../platform/config/app-config';
import { noGithubWrites } from '../../testing/github-writes';
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
const IMAGE = `ghcr.io/acme/storefront@sha256:${'c'.repeat(64)}`;
const FILE = `# The storefront: every push to main deploys it.
version: 1
name: storefront
build:
  type: image
  image: "${IMAGE}"
run:
  port: 3000
scale:
  replicas: 1 # scale later
`;
const blobOf = (text: string) => createHash('sha1').update(text).digest('hex');

/**
 * Issue #214: a Git application's shipkeep.yml as its repository holds it, whether the
 * application runs it, and what a change from the interface would write, over HTTP with
 * PostgreSQL and a fake GitHub.
 */
describe("a Git application's shipkeep.yml over HTTP", () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let admin: Client;
  const scopes: TokenScope[] = [];
  const revoked: string[] = [];
  let file = FILE;
  /** Branches GitHub refuses a commit on, as a protected branch does. */
  const protectedBranches = new Set<string>();
  const written: { branch: string; text: string }[] = [];
  const pulls: { head: string; base: string; title: string; body: string }[] = [];
  const manifests: GithubManifests = {
    convert: () =>
      Promise.resolve({
        id: 727272,
        slug: 'shipkeep-sync-d4e5f6',
        name: 'Shipkeep sync d4e5f6',
        owner: { login: 'acme-corp' },
        client_id: 'Iv23liFakeSync',
        client_secret: 'sk_test_fake_client_secret',
        webhook_secret: 'whsec_test_fake_webhook_secret',
        pem: fakePem('MIIEfakeKeyMaterialForShipkeepTests=='),
      }),
  };
  const github: GithubApi = {
    appJwt: (appId) => new Secret(`jwt-for-${String(appId)}`),
    installationToken: (_jwt, _installationId, scope) => {
      scopes.push(scope);
      return Promise.resolve({
        token: new Secret(`ghs_token_${String(scopes.length)}`),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    },
    repositories: () => Promise.resolve({ repositories: [], truncated: false }),
    repository: (_token, installationId, repositoryId) =>
      Promise.resolve({
        installationId,
        id: repositoryId,
        fullName: 'acme-corp/storefront',
        defaultBranch: 'main',
        private: true,
      }),
    branchHead: (_token, _fullName, branch) =>
      Promise.resolve(branch === 'main' ? HEAD : undefined),
    file: () => Promise.resolve(file),
    ...noGithubWrites,
    fileAt: (_token, _fullName, path, ref) =>
      Promise.resolve(
        path === 'shipkeep.yml' && (ref === HEAD || ref === 'main')
          ? { blobSha: blobOf(file), text: file }
          : undefined,
      ),
    createBranch: () => Promise.resolve(true),
    writeFile: (_token, _fullName, change) => {
      if (protectedBranches.has(change.branch)) return Promise.resolve('refused');
      written.push({ branch: change.branch, text: change.text });
      return Promise.resolve({
        commitSha: 'e'.repeat(40),
        url: `https://github.com/acme-corp/storefront/commit/${'e'.repeat(40)}`,
      });
    },
    openPullRequest: (_token, _fullName, request) => {
      pulls.push({ ...request });
      return Promise.resolve({
        number: 7,
        url: 'https://github.com/acme-corp/storefront/pull/7',
      });
    },
    revoke: (token) => {
      revoked.push(token.expose());
      return Promise.resolve(true);
    },
  };
  let applicationId = '';
  const path = () => `${fixture.environment}/applications/${applicationId}/repository-config`;
  const document = () =>
    parse(file) as { scale: Record<string, unknown> } & Record<string, unknown>;

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
        repositoryId: 601,
        branch: 'main',
      })
      .expect(201);
    applicationId = (created.body as { id: string }).id;
  });
  afterAll(async () => {
    await admin.end();
    await fixture.close();
  });

  it('shows the file, and whether the application runs it', async () => {
    const shown = await fixture.get(path(), 'owner').expect(200);
    expect(shown.body).toEqual({
      fullName: 'acme-corp/storefront',
      branch: 'main',
      configPath: 'shipkeep.yml',
      commitSha: HEAD,
      blobSha: blobOf(FILE),
      text: FILE,
      appliedCommitSha: HEAD,
      valid: true,
      applied: true,
    });
    // One repository, its contents read only, the token given back.
    expect(scopes.at(-1)).toEqual({
      repositoryIds: [601],
      permissions: { contents: 'read', metadata: 'read' },
    });
    expect(revoked).toHaveLength(scopes.length);

    // Changed in the repository and not applied yet: drift.
    file = FILE.replace('replicas: 1', 'replicas: 2');
    expect((await fixture.get(path(), 'owner').expect(200)).body).toMatchObject({
      blobSha: blobOf(file),
      valid: true,
      applied: false,
    });
    // A file this application cannot run is shown, and said invalid: another name, or the
    // control plane's own name as a domain, which a change of it would be refused for too.
    file = FILE.replace('name: storefront', 'name: another-app');
    expect((await fixture.get(path(), 'owner').expect(200)).body).toMatchObject({
      valid: false,
      applied: false,
    });
    const controlPlane = new URL(fixture.app.get(AppConfig).get('API_PUBLIC_URL')).hostname;
    file = `${FILE}domains: [${controlPlane}]\n`;
    expect((await fixture.get(path(), 'owner').expect(200)).body).toMatchObject({
      valid: false,
      applied: false,
    });
    file = FILE;
    await fixture.get(path(), 'outsider').expect(404);
  });

  it('previews a change: the text written, with its comments, and the lines it changes', async () => {
    const next = document();
    next.scale['replicas'] = 3;
    const preview = await fixture
      .post(`${path()}/preview`, 'owner', { config: next, blobSha: blobOf(FILE) })
      .expect(200);
    const body = preview.body as {
      changedText: string;
      diff: unknown[];
      blobSha: string;
      writeMode: string;
    };
    expect(body.blobSha).toBe(blobOf(FILE));
    expect(body.writeMode).toBe('pull_request');
    expect(body.changedText).toBe(FILE.replace('replicas: 1 #', 'replicas: 3 #'));
    expect(body.diff).toEqual([
      { kind: 'skipped', count: 6 },
      { kind: 'same', text: 'run:' },
      { kind: 'same', text: '  port: 3000' },
      { kind: 'same', text: 'scale:' },
      { kind: 'removed', text: '  replicas: 1 # scale later' },
      { kind: 'added', text: '  replicas: 3 # scale later' },
    ]);
  });

  it('refuses a change made against another text, invalid, renamed or not allowed', async () => {
    const next = document();
    const refused = async (body: object, status: number, code: string) => {
      const answer = await fixture.post(`${path()}/preview`, 'owner', body).expect(status);
      expect(answer.body).toMatchObject({ code });
    };
    // The file changed since it was read.
    await refused({ config: next, blobSha: 'f'.repeat(40) }, 409, 'config_file_changed');
    await refused(
      { config: { ...next, run: { port: 'x' } }, blobSha: blobOf(FILE) },
      400,
      'invalid_application_config',
    );
    await refused(
      { config: { ...next, name: 'renamed' }, blobSha: blobOf(FILE) },
      400,
      'application_name_immutable',
    );
    // Comments kept around a longer value would take the file over its size.
    // The file at exactly its largest size: one more byte is refused.
    const padded = `${FILE}#${'x'.repeat(MAX_CONFIG_BYTES - FILE.length - 2)}\n`;
    file = padded;
    const longer = document();
    longer.scale['replicas'] = 10;
    await refused({ config: longer, blobSha: blobOf(padded) }, 400, 'config_file_too_large');
    file = FILE;
    for (const blobSha of ['HEAD', '', 'A'.repeat(40)])
      await fixture.post(`${path()}/preview`, 'owner', { config: next, blobSha }).expect(400);
    await fixture
      .post(`${path()}/preview`, 'outsider', { config: next, blobSha: blobOf(FILE) })
      .expect(404);
  });

  it('refuses both for an application that runs an image', async () => {
    const created = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'image-app',
          build: { type: 'image', image: IMAGE },
          run: { port: 80 },
        },
      })
      .expect(201);
    const imagePath = `${fixture.environment}/applications/${(created.body as { id: string }).id}/repository-config`;
    expect((await fixture.get(imagePath, 'owner').expect(409)).body).toMatchObject({
      code: 'application_not_from_repository',
    });
  });
  it('writes a change as a pull request by default, audited, and leaves the application alone', async () => {
    const next = document();
    next.scale['replicas'] = 3;
    const before = (
      await fixture.get(`${fixture.environment}/applications/${applicationId}`, 'owner').expect(200)
    ).body as { configSha: string };
    const answer = await fixture
      .post(`${path()}/changes`, 'owner', { config: next, blobSha: blobOf(FILE) })
      .expect(201);
    expect(answer.body).toMatchObject({
      via: 'pull_request',
      number: 7,
      url: 'https://github.com/acme-corp/storefront/pull/7',
      commitSha: 'e'.repeat(40),
    });
    const branch = (answer.body as { branch: string }).branch;
    expect(branch).toMatch(/^shipkeep\/config-[0-9a-f]{12}$/);
    expect(written.at(-1)).toEqual({
      branch,
      text: FILE.replace('replicas: 1 #', 'replicas: 3 #'),
    });
    expect(pulls.at(-1)).toMatchObject({
      head: branch,
      base: 'main',
      title: 'Change the configuration of storefront',
    });
    // No person goes to GitHub: the audit log keeps who asked.
    expect(JSON.stringify(pulls.at(-1))).not.toContain('@');
    expect(scopes.at(-1)).toEqual({
      repositoryIds: [601],
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    });
    expect(revoked).toHaveLength(scopes.length);
    const events = await auditLog().findMany({
      where: { action: 'application.config_written', targetId: applicationId },
    });
    expect(events.map((event) => [event.actorId, event.metadata])).toEqual([
      [
        fixture.actors.owner.id,
        expect.objectContaining({
          via: 'pull_request',
          pullRequest: 7,
          pullRequestBranch: branch,
          fromCommit: HEAD,
          url: 'https://github.com/acme-corp/storefront/pull/7',
        }),
      ],
    ]);
    // The repository's push applies it, like any other: nothing changed in Shipkeep yet.
    const after = (
      await fixture.get(`${fixture.environment}/applications/${applicationId}`, 'owner').expect(200)
    ).body as { configSha: string };
    expect(after.configSha).toBe(before.configSha);
  });

  it('commits when the project says so, and makes a pull request of what a protected branch refuses', async () => {
    await admin.query(`UPDATE projects SET git_write_mode = 'commit' WHERE id = $1`, [
      fixture.projectId,
    ]);
    const next = document();
    next.scale['replicas'] = 2;
    const committed = await fixture
      .post(`${path()}/changes`, 'owner', { config: next, blobSha: blobOf(FILE) })
      .expect(201);
    expect(committed.body).toMatchObject({ via: 'commit', commitSha: 'e'.repeat(40) });
    expect(written.at(-1)).toMatchObject({ branch: 'main' });
    protectedBranches.add('main');
    const pulled = await fixture
      .post(`${path()}/changes`, 'owner', { config: next, blobSha: blobOf(FILE) })
      .expect(201);
    expect(pulled.body).toMatchObject({ via: 'pull_request', number: 7 });
    protectedBranches.clear();
    await admin.query(`UPDATE projects SET git_write_mode = 'pull_request' WHERE id = $1`, [
      fixture.projectId,
    ]);
  });

  it('answers a retry with the same key once more, and writes nothing again', async () => {
    const next = document();
    next.scale['replicas'] = 4;
    // A large configuration too: its retry is matched by the body's digest.
    next['env'] = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`SETTING_${String(index)}`, 'x'.repeat(250)]),
    );
    const key = uuidv7();
    const count = written.length;
    const first = await fixture
      .post(`${path()}/changes`, 'owner', { config: next, blobSha: blobOf(FILE) })
      .set('Idempotency-Key', key)
      .expect(201);
    const again = await fixture
      .post(`${path()}/changes`, 'owner', { config: next, blobSha: blobOf(FILE) })
      .set('Idempotency-Key', key)
      .expect(201);
    expect(again.body).toEqual(first.body);
    expect(written).toHaveLength(count + 1);
  });

  it('writes nothing for a change that changes nothing, or made against another text', async () => {
    const count = written.length;
    expect(
      (
        await fixture
          .post(`${path()}/changes`, 'owner', { config: document(), blobSha: blobOf(FILE) })
          .expect(400)
      ).body,
    ).toMatchObject({ code: 'config_unchanged' });
    const next = document();
    next.scale['replicas'] = 5;
    expect(
      (
        await fixture
          .post(`${path()}/changes`, 'owner', { config: next, blobSha: 'f'.repeat(40) })
          .expect(409)
      ).body,
    ).toMatchObject({ code: 'config_file_changed' });
    await fixture
      .post(`${path()}/changes`, 'outsider', { config: next, blobSha: blobOf(FILE) })
      .expect(404);
    expect(written).toHaveLength(count);
  });
});
