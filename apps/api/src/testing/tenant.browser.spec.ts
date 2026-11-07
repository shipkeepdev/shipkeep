import type { Download, Page } from 'playwright';

import { browserApp } from './browser-app';
import {
  accessible,
  accessibleStrict,
  createAccount,
  fillPrivate,
  FIXTURE_PASSWORD,
  signIn,
  submit,
} from './browser-identity';

const API = '/api/v1/organizations';
const APPLICATION = `version: 1
name: storefront
build:
  type: image
  image: nginx:1.27
run:
  port: 80
`;

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

async function createOrganization(page: Page, name: string, slug: string): Promise<string> {
  await page.goto('/orgs');
  await page.locator('#organization-name').fill(name);
  await page.locator('#organization-slug').fill(slug);
  await fillPrivate(page.locator('#organization-password'), FIXTURE_PASSWORD);
  const id = await created(page, 'Create organization', API);
  await page.getByRole('heading', { name: 'Overview', exact: true, level: 1 }).waitFor();
  await page.getByRole('button', { name: new RegExp(`${name}\\s*Organization`) }).waitFor();
  return id;
}

async function createProject(page: Page, organizationId: string): Promise<string> {
  await page.goto(`/orgs/${organizationId}/projects`);
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.locator('#project-name').fill('Billing');
  await page.locator('#project-slug').fill('billing');
  return created(page, 'Create project', `${API}/${organizationId}/projects`);
}

async function createEnvironment(
  page: Page,
  organizationId: string,
  projectId: string,
): Promise<string> {
  await page.goto(`/orgs/${organizationId}/projects/${projectId}`);
  await page.locator('#environment-name').fill('production');
  return created(
    page,
    'Create environment',
    `${API}/${organizationId}/projects/${projectId}/environments`,
  );
}

/** PLAN M2.3f2 and the M2.6 accessibility check: real assets, API, PostgreSQL and Chromium. */
describe('organizations and roles in Chromium', () => {
  let fixture: Awaited<ReturnType<typeof browserApp>>;
  let close: (() => Promise<void>) | undefined;
  let owner: Page;
  let outsider: Page;
  let organizationId: string;
  let projectId: string;
  let environmentId: string;
  const outsiderEmail = 'tenant-outsider@example.com';

  beforeAll(async () => {
    fixture = await browserApp();
    close = fixture.close;
  });
  afterAll(async () => {
    await close?.();
  });

  /**
   * A broken screen can still answer every locator it was never asked about: the validator refused
   * by the CSP left a blank page behind nothing but an Angular error on the console.
   */
  const problems: string[] = [];
  const watchProblems = (page: Page): void => {
    page.on('pageerror', (error) => problems.push(error.name));
    page.on('console', (message) => {
      const text = message.text();
      if (text.startsWith('ERROR') || text.includes('Content Security Policy'))
        problems.push(text.slice(0, 200));
    });
  };

  const status = async (page: Page, path: string): Promise<number> =>
    (await page.context().request.get(path)).status();

  // Accounts wait for delivered mail, which needs a test context, not beforeAll.
  it('creates two organizations through the screens', async () => {
    owner = await (await fixture.newContext()).newPage();
    watchProblems(owner);
    await createAccount(owner, fixture.messages, 'tenant-owner@example.com');
    organizationId = await createOrganization(owner, 'Acme', 'acme');
    projectId = await createProject(owner, organizationId);
    environmentId = await createEnvironment(owner, organizationId, projectId);
    outsider = await (await fixture.newContext()).newPage();
    await createAccount(outsider, fixture.messages, outsiderEmail);
    await createOrganization(outsider, 'Other', 'other');
  });

  it('answers 404 for another organization on every screen, and shows none of its data', async () => {
    const project = `/orgs/${organizationId}/projects/${projectId}`;
    for (const path of [
      `/orgs/${organizationId}`,
      `/orgs/${organizationId}/members`,
      `/orgs/${organizationId}/audit`,
      `/orgs/${organizationId}/servers`,
      project,
      `${project}/environments/${environmentId}`,
    ]) {
      const refused: number[] = [];
      const record = (response: { url: () => string; status: () => number }) => {
        const { pathname } = new URL(response.url());
        if (pathname.startsWith('/api/') && pathname.includes(organizationId))
          refused.push(response.status());
      };
      outsider.on('response', record);
      await outsider.goto(path);
      await outsider.getByRole('alert').first().waitFor();
      outsider.off('response', record);
      expect(refused.length).toBeGreaterThan(0);
      expect(refused.every((code) => code === 404)).toBe(true);
      const text = await outsider.locator('main').innerText();
      expect(text).not.toContain('Acme');
      expect(text).not.toContain('Billing');
      expect(text).not.toContain('production');
    }
    await outsider.goto('/orgs');
    await outsider.getByRole('link', { name: 'Other', exact: true }).waitFor();
    expect(await outsider.getByRole('link', { name: 'Acme', exact: true }).count()).toBe(0);
  });

  it('applies role changes on the next request', async () => {
    const organization = `${API}/${organizationId}`;
    const project = `${organization}/projects/${projectId}`;
    const expectSignedOut = async () => {
      expect(await status(outsider, '/api/v1/auth/session')).toBe(401);
      await signIn(outsider, outsiderEmail);
    };

    // Membership: reads the organization, but no project without a role.
    await owner.goto(`/orgs/${organizationId}/members`);
    await owner.getByRole('button', { name: 'Invite', exact: true }).click();
    await owner.locator('#member-add-email').fill(outsiderEmail);
    await fillPrivate(owner.locator('#member-add-password'), FIXTURE_PASSWORD);
    await submit(owner, 'Add member', `${organization}/members`, 201);
    await owner.getByRole('status').getByText('Member added.').waitFor();
    await expectSignedOut();
    expect(await status(outsider, organization)).toBe(200);
    expect(await status(outsider, project)).toBe(404);
    expect(await status(outsider, `${organization}/members`)).toBe(404);

    // A viewer role on the project: readable, and the administration panels stay away.
    await owner.goto(`/orgs/${organizationId}/projects/${projectId}`);
    await owner.getByRole('tab', { name: 'Members' }).click();
    await owner.locator('#binding-add-email').fill(outsiderEmail);
    await fillPrivate(owner.locator('#binding-add-password'), FIXTURE_PASSWORD);
    await submit(owner, 'Give role', `${project}/bindings`);
    await owner.getByRole('status').getByText('Role given.').waitFor();
    await expectSignedOut();
    expect(await status(outsider, project)).toBe(200);
    await outsider.goto(`/orgs/${organizationId}/projects/${projectId}`);
    await outsider.getByRole('heading', { name: 'Billing', exact: true }).waitFor();
    await outsider.getByRole('tab', { name: 'Environments' }).waitFor();
    await outsider.getByRole('tab', { name: 'Members' }).click();
    await outsider.waitForLoadState('networkidle');
    expect(await outsider.getByRole('heading', { name: 'Access', exact: true }).count()).toBe(0);
    expect(await outsider.locator('#binding-add-password').count()).toBe(0);

    // Removing the role, then the membership.
    await owner.reload();
    await owner.getByRole('tab', { name: 'Members' }).click();
    const person = owner.getByRole('listitem').filter({ hasText: outsiderEmail });
    await person.getByRole('button', { name: `Remove role of ${outsiderEmail}` }).click();
    await fillPrivate(owner.locator('#binding-remove-password'), FIXTURE_PASSWORD);
    const membershipId = (
      (await (await owner.context().request.get(`${organization}/members`)).json()) as {
        items: { id: string; email: string }[];
      }
    ).items.find((member) => member.email === outsiderEmail)?.id;
    if (!membershipId) throw new Error('The member is not listed.');
    await submit(owner, 'Remove role', `${project}/bindings/${membershipId}/remove`);
    await expectSignedOut();
    expect(await status(outsider, project)).toBe(404);

    await owner.goto(`/orgs/${organizationId}/members`);
    await owner
      .getByRole('listitem')
      .filter({ hasText: outsiderEmail })
      .getByRole('button', { name: `Remove ${outsiderEmail}` })
      .click();
    await fillPrivate(owner.locator('#member-remove-password'), FIXTURE_PASSWORD);
    await submit(owner, 'Remove member', `${organization}/members/${membershipId}/remove`);
    await expectSignedOut();
    expect(await status(outsider, organization)).toBe(404);
  });

  it('validates and creates an application in the browser, then follows it live', async () => {
    const environment = `/orgs/${organizationId}/projects/${projectId}/environments/${environmentId}`;
    const collection = `${API}/${organizationId}/projects/${projectId}/environments/${environmentId}/applications`;
    await owner.goto(environment);
    const config = owner.getByLabel('shipkeep.yml', { exact: true });
    await config.fill('version: 1\nname: "../etc"\n');
    await owner.getByRole('button', { name: 'Create application', exact: true }).click();
    await owner.getByRole('alert').first().waitFor();
    await config.fill(APPLICATION);
    const id = await created(owner, 'Create application', collection);
    await owner.getByRole('link', { name: 'storefront', exact: true }).click();
    await owner.getByRole('heading', { name: 'storefront', exact: true, level: 1 }).waitFor();
    await owner.getByRole('tab', { name: 'Deployments' }).click();
    await owner.getByRole('heading', { name: 'Deployments', exact: true }).waitFor();
    await accessible(owner);

    // Another tab deploys. This one has nothing running to poll for, so only the stream can tell it.
    const other = await owner.context().newPage();
    watchProblems(other);
    try {
      await other.goto(`${environment}/applications/${id}`);
      await submit(other, 'Deploy', `${collection}/${id}/deployments`, 201);
      await owner
        .locator('section[aria-labelledby="deployments-title"]')
        .getByText('queued', { exact: true })
        .waitFor();
    } finally {
      await other.close();
    }
  });

  it('meets every axe rule on sign-in and the signed-in landing pages', async () => {
    const anonymous = await (await fixture.newContext()).newPage();
    try {
      await anonymous.goto('/auth/login');
      await anonymous.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
      await accessibleStrict(anonymous);
    } finally {
      await anonymous.close();
    }
    for (const [path, heading] of [
      ['/orgs', 'Organizations'],
      [`/orgs/${organizationId}`, 'Overview'],
    ] as const) {
      await owner.goto(path);
      await owner.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
      await owner.waitForLoadState('networkidle');
      await accessibleStrict(owner);
    }
  });

  it('has no WCAG A or AA violation on any workspace screen', async () => {
    const project = `/orgs/${organizationId}/projects/${projectId}`;
    for (const [path, heading] of [
      ['/orgs', 'Organizations'],
      [`/orgs/${organizationId}`, 'Overview'],
      [`/orgs/${organizationId}/applications`, 'Applications'],
      [`/orgs/${organizationId}/members`, 'Members & access'],
      [`/orgs/${organizationId}/audit`, 'Audit log'],
      [`/orgs/${organizationId}/servers`, 'Servers'],
      [`/orgs/${organizationId}/projects`, 'Projects'],
      [`/orgs/${organizationId}/organization`, 'Acme'],
      [`/orgs/${organizationId}/new`, 'New resource'],
      [`/orgs/${organizationId}/profile`, 'tenant-owner'],
      [project, 'Billing'],
      [`${project}/environments/${environmentId}`, 'production'],
      ['/account/security', 'tenant-owner'],
    ] as const) {
      await owner.goto(path);
      await owner.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
      await owner.waitForLoadState('networkidle');
      await accessible(owner);
    }
    // The states that open on demand.
    await owner.goto(`/orgs/${organizationId}/members`);
    await owner
      .getByRole('button', { name: 'Change role of tenant-owner@example.com', exact: true })
      .click();
    await accessible(owner);
    await owner.goto('/account?section=tokens');
    await owner.getByRole('button', { name: 'Create API token', exact: true }).click();
    await owner.locator('#token-organization').selectOption(organizationId);
    await accessible(owner);
    expect(problems).toEqual([]);
  });

  it('downloads the audit export under the production CSP', async () => {
    await owner.goto(`/orgs/${organizationId}/audit`);
    const table = owner.getByRole('region', { name: 'Audit events' });
    await table.locator('button[aria-expanded]').first().waitFor();
    expect(await table.innerText()).toContain('project');
    await owner.getByRole('button', { name: 'Filter', exact: true }).click();
    await owner.locator('#audit-targetType').fill('project');
    await owner.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect
      .poll(async () => (await table.locator('button[aria-expanded]').count()) > 0, {
        timeout: 10_000,
      })
      .toBe(true);
    const [download] = (await Promise.all([
      owner.waitForEvent('download'),
      owner.getByRole('button', { name: 'Export as JSON Lines', exact: true }).click(),
    ])) as [Download, unknown];
    expect(download.suggestedFilename()).toBe(`audit-${organizationId}.jsonl`);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const lines = Buffer.concat(chunks).toString().trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines)
      expect((JSON.parse(line) as { targetType: string }).targetType).toBe('project');
    expect(problems).toEqual([]);
  });

  it('creates scoped tokens the API accepts, and revokes a project token', async () => {
    const bearer = async (path: string, token: string): Promise<number> => {
      const context = await fixture.newContext();
      try {
        const response = await context.request.get(path, {
          headers: { Authorization: `Bearer ${token}` },
        });
        return response.status();
      } finally {
        await context.close();
      }
    };
    const createToken = async (name: string, choose: () => Promise<void>): Promise<string> => {
      await owner.goto('/account?section=tokens');
      await owner.getByRole('button', { name: 'Create API token', exact: true }).click();
      await owner.getByLabel('Token name').fill(name);
      await choose();
      await fillPrivate(owner.getByLabel('Current password'), FIXTURE_PASSWORD);
      await submit(owner, 'Create API token', '/api/v1/api-tokens', 201);
      await owner.locator('#new-token').waitFor();
      const token = await owner.locator('#new-token').inputValue();
      await owner.getByRole('button', { name: 'I have saved this token' }).click();
      return token;
    };

    const organization = `${API}/${organizationId}`;
    const audit = await createToken('Audit reader', async () => {
      await owner.locator('#token-organization').selectOption(organizationId);
      await owner.getByLabel('Read and export the audit log').check();
    });
    expect(await bearer(`${organization}/audit-events`, audit)).toBe(200);
    expect(await bearer(organization, audit)).toBe(403);

    const project = `${organization}/projects/${projectId}`;
    const environment = `${project}/environments/${environmentId}`;
    const reader = await createToken('Environment reader', async () => {
      await owner.locator('#token-organization').selectOption(organizationId);
      await owner.locator('#token-project').selectOption(projectId);
      await owner.locator('#token-environment').selectOption(environmentId);
      await owner.getByLabel('Read environments, applications and deployments').check();
      await owner.getByLabel('Change applications and deploy them').check();
    });
    expect(await bearer(`${environment}/applications`, reader)).toBe(200);
    expect(await bearer(project, reader)).toBe(403);

    const bound = await createToken('Project reader', async () => {
      await owner.locator('#token-organization').selectOption(organizationId);
      await owner.locator('#token-project').selectOption(projectId);
      await owner.getByLabel('Read projects').check();
      await owner.getByLabel('Tie this token to the project').check();
    });
    expect(await bearer(project, bound)).toBe(200);
    expect(await bearer(organization, bound)).toBe(403);

    await owner.goto(`/orgs/${organizationId}/projects/${projectId}`);
    await owner.getByRole('tab', { name: 'API tokens' }).click();
    const row = owner.getByRole('listitem').filter({ hasText: 'Project reader' });
    await row.getByRole('button', { name: 'Revoke token Project reader' }).click();
    await fillPrivate(owner.locator('#project-token-password'), FIXTURE_PASSWORD);
    const listed = (await (await owner.context().request.get(`${project}/api-tokens`)).json()) as {
      items: { id: string; name: string }[];
    };
    const tokenId = listed.items.find((item) => item.name === 'Project reader')?.id;
    if (!tokenId) throw new Error('The token is not listed.');
    await submit(owner, 'Revoke token', `${project}/api-tokens/${tokenId}/revoke`, 204);
    await owner.getByRole('status').getByText('The token has been revoked.').waitFor();
    expect(await bearer(project, bound)).toBe(401);
  });

  it('saves settings and keeps a corrected slug working after a refusal', async () => {
    await owner.goto(`/orgs/${organizationId}/organization`);
    await owner.locator('#organization-settings-slug').fill('other');
    await owner.getByRole('button', { name: 'Save settings', exact: true }).click();
    await owner.getByRole('alert').first().waitFor();
    await owner.locator('#organization-settings-slug').fill('acme-corp');
    await owner.locator('#organization-settings-name').fill('Acme Corp');
    await owner.getByRole('button', { name: 'Save settings', exact: true }).click();
    await owner.getByRole('status').getByText('Settings saved.').waitFor();
    await owner.getByRole('heading', { name: 'Acme Corp', exact: true, level: 1 }).waitFor();
  });
});
