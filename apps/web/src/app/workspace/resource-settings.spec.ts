import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { appRoutes } from '../app.routes';
import { IDENTITY_FETCH } from '../identity/identity-api';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const OTHER_ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000a1';
const PROJECT = '0190f5a8-7b1c-7e2d-8f3a-0000000000bb';
const ENV = '0190f5a8-7b1c-7e2d-8f3a-0000000000cc';
const stamp = { createdAt: '2026-11-07T12:00:00Z', updatedAt: '2026-11-07T12:00:00Z' };
const organization = { id: ORG, name: 'Acme', slug: 'acme', ...stamp };
const project = {
  id: PROJECT,
  organizationId: ORG,
  name: 'Billing',
  slug: 'billing',
  gitWriteMode: 'pull_request',
  ...stamp,
};
const environment = {
  id: ENV,
  organizationId: ORG,
  projectId: PROJECT,
  name: 'production',
  kind: 'standard',
  failoverPolicy: 'none',
  protected: true,
  ...stamp,
};
const ORG_PATH = `/api/v1/organizations/${ORG}`;
const PROJECT_PATH = `${ORG_PATH}/projects/${PROJECT}`;
const ENV_PATH = `${PROJECT_PATH}/environments/${ENV}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Answer = (body: Record<string, unknown>) => Response | Promise<Response>;

describe('resource settings', () => {
  let harness: RouterTestingHarness;
  let posts: { path: string; body: Record<string, unknown> }[];
  let routes: Partial<Record<string, Answer>>;

  beforeEach(async () => {
    posts = [];
    routes = {
      [`GET ${ORG_PATH}`]: () => json(organization),
      [`GET ${ORG_PATH}/projects`]: () => json({ items: [], nextCursor: null }),
      [`GET ${PROJECT_PATH}`]: () => json(project),
      [`GET ${PROJECT_PATH}/environments`]: () => json({ items: [], nextCursor: null }),
      [`GET ${ENV_PATH}`]: () => json(environment),
      [`GET ${ENV_PATH}/applications`]: () => json({ items: [], nextCursor: null }),
      [`GET ${ENV_PATH}/secrets`]: () => json({ items: [], nextCursor: null }),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          appRoutes,
          withComponentInputBinding(),
          withRouterConfig({ paramsInheritanceStrategy: 'always' }),
        ),
        {
          provide: IDENTITY_FETCH,
          useValue: async (request: Request) => {
            const path = new URL(request.url).pathname;
            const body =
              request.method === 'POST'
                ? (JSON.parse(await request.clone().text()) as Record<string, unknown>)
                : {};
            if (request.method === 'POST') posts.push({ path, body });
            const answer = routes[`${request.method} ${path}`];
            return answer ? answer(body) : json({}, 404);
          },
        },
      ],
    });
    harness = await RouterTestingHarness.create();
  });

  function element(): HTMLElement {
    const element = harness.routeNativeElement;
    if (!element) throw new Error('missing route');
    return element;
  }
  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await harness.fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    harness.fixture.detectChanges();
  }
  function control(id: string): HTMLInputElement {
    const found = element().querySelector<HTMLInputElement>(`#${id}`);
    if (!found) throw new Error(`missing ${id}`);
    return found;
  }
  function fill(id: string, value: string): void {
    const input = control(id);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    harness.fixture.detectChanges();
  }
  function choose(id: string, value: string): void {
    const select = control(id);
    select.value = value;
    select.dispatchEvent(new Event('change'));
    harness.fixture.detectChanges();
  }
  function saveButton(): HTMLButtonElement {
    const found = [...element().querySelectorAll('button')].find((button) =>
      button.textContent.includes('Save settings'),
    );
    if (!found) throw new Error('missing save button');
    return found;
  }
  async function save(): Promise<void> {
    saveButton()
      .closest('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
  }

  it('renames an organization and shows the saved values', async () => {
    routes[`POST ${ORG_PATH}/settings`] = (body) => json({ ...organization, ...body });
    await harness.navigateByUrl(`/orgs/${ORG}/organization`);
    await settle();
    expect(control('organization-settings-name').value).toBe('Acme');
    expect(saveButton().disabled).toBe(true);
    fill('organization-settings-name', '  Acme Corp ');
    expect(saveButton().disabled).toBe(false);
    await save();
    expect(posts).toEqual([
      { path: `${ORG_PATH}/settings`, body: { name: 'Acme Corp', slug: 'acme' } },
    ]);
    expect(element().querySelector('h1')?.textContent).toContain('Acme Corp');
    expect(element().querySelector('[role="status"]')?.textContent).toContain('Settings saved.');
    expect(saveButton().disabled).toBe(true);
    fill('organization-settings-name', 'Acme Inc');
    expect(element().textContent).not.toContain('Settings saved.');
  });

  it('refuses names and slugs the API would refuse', async () => {
    await harness.navigateByUrl(`/orgs/${ORG}/organization`);
    await settle();
    for (const name of ['', '   ', 'a'.repeat(81), 'bad\u0000name', 'bidi‮name']) {
      fill('organization-settings-name', name);
      expect(saveButton().disabled).toBe(true);
    }
    fill('organization-settings-name', 'Acme');
    for (const slug of ['', 'Acme', '../../etc', '1acme', 'a b', 'a;rm -rf']) {
      fill('organization-settings-slug', slug);
      expect(saveButton().disabled).toBe(true);
    }
    expect(posts).toEqual([]);
  });

  it('accepts a corrected slug after one was refused as taken', async () => {
    routes[`POST ${ORG_PATH}/settings`] = (body) =>
      body['slug'] === 'taken' ? json({}, 409) : json({ ...organization, ...body });
    await harness.navigateByUrl(`/orgs/${ORG}/organization`);
    await settle();
    fill('organization-settings-slug', 'taken');
    await save();
    expect(element().querySelector('[role="alert"]')).not.toBeNull();
    expect(control('organization-settings-slug').value).toBe('taken');

    fill('organization-settings-slug', 'acme-corp');
    expect(element().querySelector('[role="alert"]')).toBeNull();
    await save();
    expect(posts.at(-1)?.body).toEqual({ name: 'Acme', slug: 'acme-corp' });
    expect(element().querySelector('[role="status"]')).not.toBeNull();
  });

  it('applies the same recovery to a create form', async () => {
    routes[`POST ${ORG_PATH}/projects`] = (body) =>
      body['slug'] === 'taken' ? json({}, 409) : json({ ...project, ...body }, 201);
    await harness.navigateByUrl(`/orgs/${ORG}/projects`);
    await settle();
    [...element().querySelectorAll('button')]
      .find((b) => b.textContent.includes('New project'))
      ?.click();
    await settle();
    fill('project-name', 'Billing');
    fill('project-slug', 'taken');
    const form = control('project-name').closest('form');
    form?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    fill('project-slug', 'billing');
    form?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(posts.map((post) => post.body['slug'])).toEqual(['taken', 'billing']);
  });

  it('drops a save that answers after moving to another organization', async () => {
    let release: (response: Response) => void = () => undefined;
    routes[`POST ${ORG_PATH}/settings`] = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    routes[`GET /api/v1/organizations/${OTHER_ORG}`] = () =>
      json({ ...organization, id: OTHER_ORG, name: 'Other', slug: 'other' });
    routes[`GET /api/v1/organizations/${OTHER_ORG}/projects`] = () =>
      json({ items: [], nextCursor: null });
    await harness.navigateByUrl(`/orgs/${ORG}/organization`);
    await settle();
    fill('organization-settings-name', 'Renamed');
    await save();
    await harness.navigateByUrl(`/orgs/${OTHER_ORG}/organization`);
    await settle();
    release(json({ ...organization, name: 'Renamed' }));
    await settle();
    expect(element().querySelector('h1')?.textContent).toContain('Other');
    expect(control('organization-settings-name').value).toBe('Other');
    expect(element().querySelector('[role="status"]')).toBeNull();
  });

  it('saves how a project writes to its configuration', async () => {
    routes[`POST ${PROJECT_PATH}/settings`] = (body) => json({ ...project, ...body });
    await harness.navigateByUrl(`/orgs/${ORG}/projects/${PROJECT}`);
    await settle();
    expect(control('project-settings-git').value).toBe('pull_request');
    choose('project-settings-git', 'commit');
    await save();
    expect(posts).toEqual([
      {
        path: `${PROJECT_PATH}/settings`,
        body: { name: 'Billing', slug: 'billing', gitWriteMode: 'commit' },
      },
    ]);
  });

  it('saves environment protection as a boolean and updates the page', async () => {
    routes[`POST ${ENV_PATH}/settings`] = (body) => json({ ...environment, ...body });
    await harness.navigateByUrl(`/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}`);
    await settle();
    expect(element().textContent).toContain('only administrators deploy here');
    const box = control('environment-settings-protected');
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    choose('environment-settings-failover', 'restore-from-backup');
    await save();
    expect(posts).toEqual([
      {
        path: `${ENV_PATH}/settings`,
        body: {
          name: 'production',
          kind: 'standard',
          failoverPolicy: 'restore-from-backup',
          protected: false,
        },
      },
    ]);
    expect(element().textContent).toContain('Developers can deploy here.');
  });

  it('explains a refusal and keeps what was typed', async () => {
    routes[`POST ${ENV_PATH}/settings`] = () => json({}, 404);
    await harness.navigateByUrl(`/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}`);
    await settle();
    fill('environment-settings-name', 'staging');
    await save();
    expect(element().querySelector('[role="alert"]')).not.toBeNull();
    expect(control('environment-settings-name').value).toBe('staging');
    expect(element().querySelector('h1')?.textContent).toContain('production');
  });
});
