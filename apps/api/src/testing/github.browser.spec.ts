import { createHmac, randomUUID } from 'node:crypto';

import { Secret } from '@shipkeep/domain';
import type { Page } from 'playwright';

import {
  GITHUB_API,
  GITHUB_MANIFESTS,
  type GithubApi,
  type GithubManifests,
} from '../modules/git/application/ports';

import { browserApp } from './browser-app';
import { createAccount, fillPrivate, FIXTURE_PASSWORD } from './browser-identity';

const API = '/api/v1/organizations';
const WEBHOOK = 'whsec_test_fake_webhook_secret';
const APP_ID = 929292;
const HEAD = 'a'.repeat(40);

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
    file: () =>
      Promise.resolve(
        `version: 1\nname: billing\nbuild:\n  type: image\n  image: ghcr.io/acme/billing@sha256:${'c'.repeat(64)}\nrun:\n  port: 3000\n`,
      ),
    revoke: () => Promise.resolve(),
  };

  beforeAll(async () => {
    fixture = await browserApp([
      { token: GITHUB_MANIFESTS, value: manifests },
      { token: GITHUB_API, value: github },
    ]);
    close = fixture.close;
  });
  afterAll(async () => {
    await close?.();
  });

  it('creates the App through GitHub, then an application from a repository it reaches', async () => {
    const owner = await (await fixture.newContext()).newPage();
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
    expect(problems).toEqual([]);
  });
});
