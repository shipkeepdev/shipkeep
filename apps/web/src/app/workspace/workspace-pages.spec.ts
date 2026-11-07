import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { appRoutes } from '../app.routes';
import { IDENTITY_FETCH } from '../identity/identity-api';
import { SessionStore } from '../identity/session-store';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const PROJECT = '0190f5a8-7b1c-7e2d-8f3a-0000000000bb';
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

  beforeEach(async () => {
    requests = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter(appRoutes, withComponentInputBinding()),
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
        ? json({ items: [organization], nextCursor: null })
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
      expiresAt: '2030-01-01T00:00:00Z',
    });
  });

  it('shows an organization with its projects and creates a project', async () => {
    let projects = [project];
    handler = (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'POST') {
        projects = [...projects, { ...project, id: 'p2', name: 'Web', slug: 'web' }];
        return json(projects.at(-1), 201);
      }
      return path.endsWith('/projects')
        ? json({ items: projects, nextCursor: null })
        : json(organization);
    };
    await harness.navigateByUrl(`/orgs/${ORG}`);
    await settle();
    expect(element().querySelector('h1')?.textContent).toContain('Acme');
    expect(element().querySelector('ul[aria-label="Projects"]')?.textContent).toContain('Billing');
    fill('project-name', 'Web');
    fill('project-slug', 'web');
    await submit();
    expect(requests.find((r) => r.method === 'POST')).toMatchObject({
      path: `/api/v1/organizations/${ORG}/projects`,
      body: { name: 'Web', slug: 'web', gitWriteMode: 'commit' },
    });
    expect(element().querySelector('ul[aria-label="Projects"]')?.textContent).toContain('Web');
  });

  it('creates protected environments by default', async () => {
    handler = (request) => {
      const path = new URL(request.url).pathname;
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
    expect(element().textContent).toContain('No environments yet.');
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
    await harness.navigateByUrl(`/orgs/${ORG}`);
    await settle();
    expect(element().querySelector('[role="alert"]')?.textContent).toContain(
      'This item is no longer available.',
    );
    expect(element().textContent).not.toContain('internal detail');
  });
});
