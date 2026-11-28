import { TestBed } from '@angular/core/testing';
import {
  provideRouter,
  Router,
  withComponentInputBinding,
  withRouterConfig,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { appRoutes } from '../app.routes';
import { IDENTITY_FETCH } from '../identity/identity-api';
import { PRIVATE_CLIPBOARD } from '../identity/private-clipboard';
import { SessionStore } from '../identity/session-store';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const PROJECT = '0190f5a8-7b1c-7e2d-8f3a-0000000000bb';
const ENV = '0190f5a8-7b1c-7e2d-8f3a-0000000000cc';
const stamp = { createdAt: '2026-11-05T12:00:00Z', updatedAt: '2026-11-05T12:00:00Z' };
const organization = { id: ORG, name: 'Acme', slug: 'acme', ...stamp };
const project = {
  id: PROJECT,
  organizationId: ORG,
  name: 'Billing',
  slug: 'billing',
  gitWriteMode: 'commit',
  ...stamp,
};

type Handler = (request: Request) => Response | Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('workspace pages', () => {
  let harness: RouterTestingHarness;
  let requests: { method: string; path: string; body: unknown }[];
  let handler: Handler;
  let copied: string[];

  beforeEach(async () => {
    requests = [];
    copied = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          appRoutes,
          withComponentInputBinding(),
          withRouterConfig({ paramsInheritanceStrategy: 'always' }),
        ),
        {
          provide: PRIVATE_CLIPBOARD,
          useValue: (value: string) => {
            copied.push(value);
            return Promise.resolve();
          },
        },
        {
          provide: IDENTITY_FETCH,
          useValue: async (request: Request) => {
            const text = request.method === 'GET' ? '' : await request.clone().text();
            requests.push({
              method: request.method,
              path: new URL(request.url).pathname,
              body: text ? (JSON.parse(text) as unknown) : undefined,
            });
            return handler(request);
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
    for (let i = 0; i < 5; i++) {
      await harness.fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    harness.fixture.detectChanges();
  }
  function fill(id: string, value: string | boolean): void {
    const input = element().querySelector<HTMLInputElement>(`#${id}`);
    if (!input) throw new Error(`missing ${id}`);
    if (typeof value === 'boolean') {
      input.checked = value;
      input.dispatchEvent(new Event('change'));
    } else {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
  }
  async function submit(): Promise<void> {
    harness.fixture.detectChanges();
    element()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  }

  it('lists organizations and creates one with the password, adopting the new session', async () => {
    handler = (request) =>
      request.method === 'GET'
        ? new URL(request.url).pathname === '/api/v1/organizations'
          ? json({ items: [organization], nextCursor: null })
          : json({ items: [], nextCursor: null })
        : json(
            {
              organization: {
                ...organization,
                id: '0190f5a8-7b1c-7e2d-8f3a-0000000000cc',
                name: 'New',
              },
              session: {
                userId: 'u',
                email: 'person@example.com',
                displayName: null,
                expiresAt: '2030-01-01T00:00:00Z',
                extra: 'secret',
              },
            },
            201,
          );
    await harness.navigateByUrl('/orgs');
    await settle();
    expect(element().querySelector('ul[aria-label="Your organizations"]')?.textContent).toContain(
      'Acme',
    );
    fill('organization-name', 'New');
    fill('organization-slug', 'new-org');
    fill('organization-password', 'correct horse browser fixture');
    await submit();
    expect(requests.find((r) => r.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/v1/organizations',
      body: { name: 'New', slug: 'new-org', password: 'correct horse browser fixture' },
    });
    expect(TestBed.inject(Router).url).toBe('/orgs/0190f5a8-7b1c-7e2d-8f3a-0000000000cc');
    expect(TestBed.inject(SessionStore).profile()).toEqual({
      userId: 'u',
      email: 'person@example.com',
      displayName: null,
      expiresAt: '2030-01-01T00:00:00Z',
    });
  });

  it('shows an organization with its projects and creates a project', async () => {
    let projects = [project];
    handler = (request) => {
      const path = new URL(request.url).pathname;
      // The dashboard frame lists servers and members too.
      if (/\/(members|nodes|audit-events)$/.test(path))
        return json({ items: [], nextCursor: null });
      if (request.method === 'POST') {
        projects = [...projects, { ...project, id: 'p2', name: 'Web', slug: 'web' }];
        return json(projects.at(-1), 201);
      }
      return path.endsWith('/projects')
        ? json({ items: projects, nextCursor: null })
        : json(organization);
    };
    await harness.navigateByUrl(`/orgs/${ORG}/projects`);
    await settle();
    expect(element().querySelector('h1')?.textContent).toContain('Projects');
    expect(element().querySelector('main')?.textContent).toContain('Billing');
    [...element().querySelectorAll('button')]
      .find((b) => b.textContent.includes('New project'))
      ?.click();
    await settle();
    fill('project-name', 'Web');
    fill('project-slug', 'web');
    await submit();
    expect(requests.find((r) => r.method === 'POST')).toMatchObject({
      path: `/api/v1/organizations/${ORG}/projects`,
      body: { name: 'Web', slug: 'web', gitWriteMode: 'commit' },
    });
    expect(element().querySelector('main')?.textContent).toContain('Web');
  });

  it('creates protected environments by default', async () => {
    handler = (request) => {
      const path = new URL(request.url).pathname;
      // The dashboard frame lists servers and members too.
      if (/\/(members|nodes|audit-events)$/.test(path))
        return json({ items: [], nextCursor: null });
      if (request.method === 'POST')
        return json(
          {
            id: 'e1',
            organizationId: ORG,
            projectId: PROJECT,
            name: 'production',
            kind: 'standard',
            failoverPolicy: 'none',
            protected: true,
            ...stamp,
          },
          201,
        );
      return path.endsWith('/environments') ||
        path.endsWith('/bindings') ||
        path.endsWith('/api-tokens')
        ? json({ items: [], nextCursor: null })
        : json(project);
    };
    await harness.navigateByUrl(`/orgs/${ORG}/projects/${PROJECT}`);
    await settle();
    expect(element().textContent).toContain('No environment yet.');
    fill('environment-name', 'production');
    await submit();
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
      name: 'production',
      protected: true,
      kind: 'standard',
      failoverPolicy: 'none',
    });
  });

  it('explains a missing or forbidden organization without server details', async () => {
    handler = () =>
      json({ type: 'https://shipkeep.dev/problems/not_found', detail: 'internal detail' }, 404);
    await harness.navigateByUrl(`/orgs/${ORG}/organization`);
    await settle();
    const alerts = [...element().querySelectorAll('[role="alert"]')].map((a) => a.textContent);
    expect(alerts.join(' ')).toContain('This item is no longer available.');
    expect(alerts.join(' ')).toContain('This organization is not available to your account');
    expect(element().textContent).not.toContain('internal detail');
  });

  it('shows CLI identifiers, export command, copy actions and preselected token link on the environment page', async () => {
    handler = (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/environments/${ENV}`)) {
        return json({
          id: ENV,
          organizationId: ORG,
          projectId: PROJECT,
          name: 'production',
          kind: 'standard',
          failoverPolicy: 'none',
          protected: true,
          ...stamp,
        });
      }
      if (/\/(members|nodes|audit-events|applications|secrets|bindings)$/.test(path))
        return json({ items: [], nextCursor: null });
      return json(project);
    };
    await harness.navigateByUrl(`/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}`);
    await settle();

    const text = element().textContent;
    expect(text).toContain('Use from the CLI');
    expect(text).toContain(ORG);
    expect(text).toContain(PROJECT);
    expect(text).toContain(ENV);
    const expectedExport = `export SHIPKEEP_ORG=${ORG} SHIPKEEP_PROJECT=${PROJECT} SHIPKEEP_ENV=${ENV}`;
    expect(text).toContain(expectedExport);

    element()
      .querySelector<HTMLButtonElement>('button[aria-label="Copy organization ID"]')
      ?.click();
    await settle();
    element().querySelector<HTMLButtonElement>('button[aria-label="Copy project ID"]')?.click();
    await settle();
    element().querySelector<HTMLButtonElement>('button[aria-label="Copy environment ID"]')?.click();
    await settle();
    [...element().querySelectorAll('button')]
      .find((button) => button.textContent.includes('Copy export command'))
      ?.click();
    await settle();

    expect(copied).toEqual([ORG, PROJECT, ENV, expectedExport]);

    const tokenLink = [...element().querySelectorAll('a')].find((anchor) =>
      anchor.textContent.includes('Create an API token for this environment'),
    );
    expect(tokenLink?.getAttribute('href')).toBe(
      `/account?section=tokens&organizationId=${ORG}&projectId=${PROJECT}&environmentId=${ENV}`,
    );
  });
});
