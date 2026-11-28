import { createHash, createHmac, randomUUID } from 'node:crypto';

import { Secret } from '@shipkeep/domain';
import type { Page } from 'playwright';

import {
  GITHUB_API,
  GITHUB_MANIFESTS,
  type GithubApi,
  type GithubManifests,
} from '../modules/git/application/ports';
import { LOGS_STORE, type LogsStore } from '../modules/observability/application/ports';

import { browserApp } from './browser-app';
import {
  accessible,
  createAccount,
  fillPrivate,
  FIXTURE_PASSWORD,
  submit,
} from './browser-identity';
import { enrollTestNode } from './enroll-test-node';
import { noGithubWrites } from './github-writes';

const API = '/api/v1/organizations';
const WEBHOOK = 'whsec_test_fake_webhook_secret';
const APP_ID = 929292;
const HEAD = 'a'.repeat(40);
/** The repository's shipkeep.yml, comments included (#214). */
const CONFIG =
  '# Billing, built from its Dockerfile.\nversion: 1\nname: billing\nbuild:\n  type: dockerfile\nrun:\n  port: 3000 # the API\n';
/** What rootless BuildKit writes for a small Node service, as the agent sends it (ADR 0032). */
const BUILD_OUTPUT = [
  '#0 building with "default" instance using rootless buildkitd',
  `#1 [internal] load git source https://github.com/acme-corp/billing.git#${HEAD}`,
  `#1 0.412 ${HEAD}\trefs/heads/main`,
  '#1 DONE 1.1s',
  '#2 [internal] load metadata for docker.io/library/node:22-alpine',
  '#2 DONE 0.9s',
  '#3 [deps 1/3] FROM docker.io/library/node:22-alpine',
  '#3 CACHED',
  '#4 [deps 2/3] COPY package.json package-lock.json ./',
  '#4 DONE 0.1s',
  '#5 [deps 3/3] RUN npm ci --omit=dev',
  '#5 4.211 added 214 packages, and audited 215 packages in 4s',
  '#5 DONE 4.6s',
  '#6 [build 1/2] COPY . .',
  '#6 DONE 0.2s',
  '#7 [build 2/2] RUN npm run build',
  '#7 0.512 > billing@1.4.0 build',
  '#7 0.513 > tsc -p tsconfig.build.json',
  '#7 DONE 9.8s',
  '#8 exporting to image',
  '#8 exporting layers 1.2s done',
];

/** A key-shaped value that is no key, put together here so that no scanner reads the source as one. */
function fakePem(body: string): string {
  const armor = (edge: string, kind = 'PRIVATE') => `-----${edge} RSA ${kind} KEY-----`;
  return `${armor('BEGIN')}\n${body}\n${armor('END')}\n`;
}

async function created(page: Page, button: string, path: string): Promise<string> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === path && candidate.request().method() === 'POST',
    ),
    page.getByRole('button', { name: button, exact: true }).click(),
  ]);
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { id?: string; organization?: { id: string } };
  const id = body.organization?.id ?? body.id;
  if (!id) throw new Error('The created resource has no id.');
  return id;
}

/**
 * Issue #213 in Chromium, with a fake GitHub behind the API and in front of the browser: an owner
 * creates the organization's GitHub App through the manifest flow (the CSP lets the form go to
 * github.com and nowhere else), the App's installation arrives as a signed webhook, and an
 * application is created from a repository it reaches.
 */
describe('GitHub in Chromium', () => {
  let fixture: Awaited<ReturnType<typeof browserApp>>;
  let close: (() => Promise<void>) | undefined;
  const problems: string[] = [];
  let owner: Page;
  let application = '';
  /** The application's deployments in the API. */
  let deployments = '';
  /** The build lines the log store answers, stamped from its first build read. */
  let builtFrom: number | undefined;
  const logs: LogsStore = {
    write: () => Promise.resolve(),
    query: (logsql) => {
      if (!logsql.includes('stream="build"')) return Promise.resolve([]);
      // Stamped just before the first read: after the deployment was queued, as a build would be.
      builtFrom ??= Date.now() - 1_000;
      const base = builtFrom;
      return Promise.resolve(
        BUILD_OUTPUT.map((line, index) => ({
          _time: new Date(base + index * 40).toISOString(),
          _msg: line,
          stream: 'build',
          instance: 'build',
        })),
      );
    },
  };
  const manifests: GithubManifests = {
    convert: (code) =>
      Promise.resolve(
        code === 'c0de'
          ? {
              id: APP_ID,
              slug: 'shipkeep-acme-a1b2c3',
              name: 'Shipkeep acme a1b2c3',
              owner: { login: 'acme-corp' },
              client_id: 'Iv23liFakeBrowser',
              client_secret: 'sk_test_fake_client_secret',
              webhook_secret: WEBHOOK,
              pem: fakePem('MIIEfakeKeyMaterialForShipkeepTests=='),
            }
          : {},
      ),
  };
  /** What GitHub received from the configuration editor (#214). */
  const written: { branch: string; text: string }[] = [];
  const pulls: { head: string; base: string; title: string }[] = [];
  const github: GithubApi = {
    appJwt: (appId) => new Secret(`jwt-for-${String(appId)}`),
    installationToken: () =>
      Promise.resolve({
        token: new Secret('ghs_token_for_browser'),
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    repositories: (_token, installationId) =>
      Promise.resolve({
        repositories: [
          {
            installationId,
            id: 501,
            fullName: 'acme-corp/billing',
            defaultBranch: 'main',
            private: true,
          },
        ],
        truncated: false,
      }),
    repository: (_token, installationId, repositoryId) =>
      Promise.resolve({
        installationId,
        id: repositoryId,
        fullName: 'acme-corp/billing',
        defaultBranch: 'main',
        private: true,
      }),
    branchHead: () => Promise.resolve(HEAD),
    file: () => Promise.resolve(CONFIG),
    ...noGithubWrites,
    fileAt: () =>
      Promise.resolve({ blobSha: createHash('sha1').update(CONFIG).digest('hex'), text: CONFIG }),
    createBranch: () => Promise.resolve(true),
    // A new branch holds no earlier attempt of the change, and has no pull request open yet.
    commitMessage: () => Promise.resolve(undefined),
    openPullRequestFrom: () => Promise.resolve(undefined),
    writeFile: (_token, _fullName, change) => {
      written.push({ branch: change.branch, text: change.text });
      return Promise.resolve({
        commitSha: 'c'.repeat(40),
        url: `https://github.com/acme-corp/billing/commit/${'c'.repeat(40)}`,
      });
    },
    openPullRequest: (_token, _fullName, request) => {
      pulls.push({ head: request.head, base: request.base, title: request.title });
      return Promise.resolve({ number: 12, url: 'https://github.com/acme-corp/billing/pull/12' });
    },
    revoke: () => Promise.resolve(true),
  };

  beforeAll(async () => {
    fixture = await browserApp([
      { token: GITHUB_MANIFESTS, value: manifests },
      { token: GITHUB_API, value: github },
      { token: LOGS_STORE, value: logs },
    ]);
    close = fixture.close;
  });
  afterAll(async () => {
    await close?.();
  });

  it('creates the App through GitHub, then an application from a repository it reaches', async () => {
    owner = await (await fixture.newContext()).newPage();
    owner.on('pageerror', (error) => problems.push(error.name));
    owner.on('console', (message) => {
      const text = message.text();
      if (text.startsWith('ERROR') || text.includes('Content Security Policy'))
        problems.push(text.slice(0, 200));
    });
    await createAccount(owner, fixture.messages, 'github-owner@example.com');
    await owner.goto('/orgs');
    await owner.locator('#organization-name').fill('Acme');
    await owner.locator('#organization-slug').fill('acme');
    await fillPrivate(owner.locator('#organization-password'), FIXTURE_PASSWORD);
    const organizationId = await created(owner, 'Create organization', API);
    await owner.getByRole('heading', { name: 'Overview', exact: true, level: 1 }).waitFor();

    // GitHub: it takes the manifest the form posted, then sends the owner back with a code.
    const posted: string[] = [];
    await owner.route('https://github.com/**', async (route) => {
      const request = route.request();
      posted.push(request.postData() ?? '');
      const state = new URL(request.url()).searchParams.get('state') ?? '';
      await route.fulfill({
        status: 302,
        headers: {
          location: `${fixture.origin}/orgs/${organizationId}/integrations/github?code=c0de&state=${encodeURIComponent(state)}`,
        },
      });
    });
    await owner.goto(`/orgs/${organizationId}/integrations`);
    await owner.getByRole('button', { name: 'Create the GitHub App', exact: true }).click();
    await owner.waitForURL(`**/orgs/${organizationId}/integrations?connected=github`);
    expect(posted).toHaveLength(1);
    const manifest = JSON.parse(new URLSearchParams(posted[0]).get('manifest') ?? '{}') as {
      name?: string;
      public?: boolean;
    };
    expect(manifest.name).toMatch(/^Shipkeep acme /);
    expect(manifest.public).toBe(false);
    await owner.getByText('On the GitHub account acme-corp', { exact: true }).waitFor();
    await owner.getByText('No repository yet', { exact: false }).waitFor();

    // GitHub reports the App's installation, signed with its webhook secret.
    const event = JSON.stringify({
      action: 'created',
      installation: {
        id: 77,
        app_id: APP_ID,
        repository_selection: 'selected',
        updated_at: new Date().toISOString(),
        account: { login: 'acme-corp', type: 'Organization' },
      },
      sender: { login: 'octocat' },
    });
    const delivered = await owner
      .context()
      .request.post(`/api/v1/webhooks/github/${organizationId}`, {
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'installation',
          'x-github-delivery': randomUUID(),
          'x-hub-signature-256': `sha256=${createHmac('sha256', WEBHOOK).update(event).digest('hex')}`,
        },
        data: event,
      });
    expect(delivered.status()).toBe(204);
    await owner.reload();
    await owner.getByText('acme-corp/billing', { exact: true }).waitFor();

    // An application whose configuration is that repository's shipkeep.yml.
    await owner.goto(`/orgs/${organizationId}/projects`);
    await owner.getByRole('button', { name: 'New project', exact: true }).click();
    await owner.locator('#project-name').fill('Billing');
    await owner.locator('#project-slug').fill('billing');
    const projectId = await created(owner, 'Create project', `${API}/${organizationId}/projects`);
    await owner.goto(`/orgs/${organizationId}/projects/${projectId}`);
    await owner.locator('#environment-name').fill('production');
    const environmentId = await created(
      owner,
      'Create environment',
      `${API}/${organizationId}/projects/${projectId}/environments`,
    );
    await owner.goto(
      `/orgs/${organizationId}/projects/${projectId}/environments/${environmentId}?tab=applications`,
    );
    await owner.locator('#github-repository').waitFor();
    expect(await owner.locator('#github-branch').inputValue()).toBe('main');
    const form = owner.locator('section[aria-labelledby="github-create-title"]');
    const [response] = await Promise.all([
      owner.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname.endsWith('/applications/github') &&
          candidate.request().method() === 'POST',
      ),
      form.getByRole('button', { name: 'Create application', exact: true }).click(),
    ]);
    expect(response.status()).toBe(201);
    await owner.getByText('acme-corp/billing · main', { exact: true }).waitFor();
    const applicationId = ((await response.json()) as { id: string }).id;
    application = `/orgs/${organizationId}/projects/${projectId}/environments/${environmentId}/applications/${applicationId}`;
    deployments = `${API}/${organizationId}/projects/${projectId}/environments/${environmentId}/applications/${applicationId}/deployments`;
    // A server to build on: the deployment places its replica there, then builds.
    const session = (await (await owner.context().request.get('/api/v1/auth/session')).json()) as {
      userId: string;
    };
    await enrollTestNode(
      { app: fixture.app, organizationId, actors: { owner: { id: session.userId } } },
      {
        facts: {
          hostname: 'builder-browser.example.com',
          cpu_count: 2,
          memory_bytes: 4 * 2 ** 30,
          architecture: 'amd64',
        },
        heartbeatAt: new Date(),
      },
    );
    expect(problems).toEqual([]);
  });

  it('shows the build output of a deployment as it runs, under the production CSP (#265)', async () => {
    await owner.goto(application);
    await submit(owner, 'Deploy', deployments, 201);
    await owner.goto(`${application}?tab=deployments`);
    await owner
      .getByRole('link', { name: /^Open deployment / })
      .first()
      .click();
    await owner.getByRole('heading', { name: 'Build output', exact: true, level: 2 }).waitFor();
    const output = owner.getByRole('log', { name: 'Build output' });
    await output.getByText('#7 DONE 9.8s').waitFor();
    expect(await output.innerText()).toContain('#5 [deps 3/3] RUN npm ci --omit=dev');
    // Read again while it runs, each line still shown once.
    await owner.waitForResponse((candidate) =>
      new URL(candidate.url()).pathname.endsWith('/build-output'),
    );
    expect(await output.getByText('#7 DONE 9.8s').count()).toBe(1);
    await accessible(owner);
    expect(problems).toEqual([]);
  });
  // #214's acceptance: editing replicas in the interface opens a pull request with the exact YAML
  // change, under the production CSP.
  it('opens a pull request with the exact change of replicas made in the editor (#214)', async () => {
    await owner.goto(`${application}?tab=config&section=yml`);
    const editor = owner.locator('#configuration-draft');
    await editor.waitFor();
    expect(await editor.inputValue()).toBe(CONFIG);
    await owner.getByText('The application runs this file, at commit aaaaaaa.').waitFor();
    await editor.fill(`${CONFIG}scale:\n  replicas: 3\n`);
    await owner.getByRole('button', { name: 'Review changes', exact: true }).click();
    const changes = owner.locator('pre[aria-label="Changes to write"]');
    await changes.getByText('+   replicas: 3').waitFor();
    await accessible(owner);
    const [response] = await Promise.all([
      owner.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname.endsWith('/repository-config/changes') &&
          candidate.request().method() === 'POST',
      ),
      owner.getByRole('button', { name: 'Open a pull request', exact: true }).click(),
    ]);
    expect(response.status()).toBe(201);
    await owner
      .getByText(
        'Pull request #12 opened. Merging it into main deploys the change, unless the environment is protected.',
      )
      .waitFor();
    // Only the lines added: the comments and the rest of the file are as the repository has them.
    expect(written).toEqual([
      {
        branch: expect.stringMatching(/^shipkeep\/config-[0-9a-f]{16}$/) as string,
        text: `${CONFIG}scale:\n  replicas: 3\n`,
      },
    ]);
    expect(pulls).toEqual([
      { head: written[0]?.branch, base: 'main', title: 'Change the configuration of billing' },
    ]);
    expect(
      await owner.getByRole('link', { name: 'Open on GitHub', exact: true }).getAttribute('href'),
    ).toBe('https://github.com/acme-corp/billing/pull/12');
    // The change is in the pull request: the editor holds the branch's file again.
    await expect.poll(() => editor.inputValue()).toBe(CONFIG);
    await accessible(owner);
    expect(problems).toEqual([]);
  });
});
