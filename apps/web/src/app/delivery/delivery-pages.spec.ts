import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { appRoutes } from '../app.routes';
import { IDENTITY_FETCH } from '../identity/identity-api';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const PROJECT = '0190f5a8-7b1c-7e2d-8f3a-0000000000bb';
const ENV = '0190f5a8-7b1c-7e2d-8f3a-0000000000cc';
const APP = '0190f5a8-7b1c-7e2d-8f3a-0000000000dd';
const BASE = `/api/v1/organizations/${ORG}/projects/${PROJECT}/environments/${ENV}`;
const stamp = { createdAt: '2026-11-06T09:00:00Z', updatedAt: '2026-11-06T09:00:00Z' };
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
const application = {
  id: APP,
  name: 'billing-api',
  source: 'image',
  config: {
    version: 1,
    name: 'billing-api',
    build: { type: 'image', image: 'nginx:1.27' },
    run: { port: 80 },
  },
  configSha: 'a'.repeat(64),
  createdBy: null,
  ...stamp,
};
const deployment = (state: string, error: string | null = null) => ({
  id: '0190f5a8-7b1c-7e2d-8f3a-0000000000ee',
  releaseId: '0190f5a8-7b1c-7e2d-8f3a-0000000000ff',
  state,
  build: false,
  release: false,
  trigger: 'manual',
  actorId: null,
  error,
  startedAt: '2026-11-06T09:00:00Z',
  finishedAt: null,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('delivery screens', () => {
  let harness: RouterTestingHarness;
  let requests: { method: string; path: string; body: unknown }[];
  let routes: Partial<Record<string, () => Response>>;

  beforeEach(async () => {
    requests = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter(appRoutes, withComponentInputBinding()),
        {
          provide: IDENTITY_FETCH,
          useValue: async (request: Request) => {
            const path = new URL(request.url).pathname;
            const text = request.method === 'GET' ? '' : await request.clone().text();
            requests.push({
              method: request.method,
              path,
              body: text ? (JSON.parse(text) as unknown) : undefined,
            });
            const handler = routes[`${request.method} ${path}`];
            return handler ? handler() : json({}, 404);
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
  function fill(id: string, value: string): void {
    const input = element().querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
    if (!input) throw new Error(`missing ${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
  async function submit(index: number): Promise<void> {
    harness.fixture.detectChanges();
    element()
      .querySelectorAll('form')
      .item(index)
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  }

  it('validates shipkeep.yml in the browser before creating an application', async () => {
    let applications: unknown[] = [];
    routes = {
      [`GET ${BASE}`]: () => json(environment),
      [`GET ${BASE}/applications`]: () => json({ items: applications }),
      [`GET ${BASE}/secrets`]: () => json({ items: [] }),
      [`POST ${BASE}/applications`]: () => {
        applications = [application];
        return json(application, 201);
      },
    };
    await harness.navigateByUrl(`/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}`);
    await settle();
    expect(element().textContent).toContain('No applications yet.');

    fill('application-config', 'version: 1\nname: Bad Name\nbuild: { type: image }\n');
    await submit(0);
    expect(element().querySelector('[role="alert"]')?.textContent).toContain('/name');
    expect(requests.some((r) => r.method === 'POST')).toBe(false);

    fill(
      'application-config',
      'version: 1\nname: billing-api\nbuild:\n  type: image\n  image: nginx:1.27\nrun:\n  port: 80\n',
    );
    await submit(0);
    expect(requests.find((r) => r.method === 'POST')).toEqual({
      method: 'POST',
      path: `${BASE}/applications`,
      body: { config: application.config },
    });
    expect(element().querySelector('ul[aria-label="Applications"]')?.textContent).toContain(
      'billing-api',
    );
  });

  it('sets write-only secrets and never shows their values', async () => {
    let secrets: unknown[] = [];
    routes = {
      [`GET ${BASE}`]: () => json(environment),
      [`GET ${BASE}/applications`]: () => json({ items: [] }),
      [`GET ${BASE}/secrets`]: () => json({ items: secrets }),
      [`POST ${BASE}/secrets`]: () => {
        secrets = [{ name: 'DATABASE_URL', version: 1, updatedBy: null, ...stamp }];
        return json(secrets[0]);
      },
      [`POST ${BASE}/secrets/DATABASE_URL/remove`]: () => {
        secrets = [];
        return new Response(null, { status: 204 });
      },
    };
    await harness.navigateByUrl(`/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}`);
    await settle();
    fill('secret-name', 'DATABASE_URL');
    fill('secret-value', 'postgres://fixture:private@db/app');
    await submit(1);
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
      name: 'DATABASE_URL',
      value: 'postgres://fixture:private@db/app',
    });
    expect(element().querySelector('ul[aria-label="Secrets"]')?.textContent).toContain('version 1');
    expect(element().textContent).not.toContain('private');
    expect(element().querySelector<HTMLInputElement>('#secret-value')?.value).toBe('');

    element().querySelector<HTMLButtonElement>('button[aria-label="Remove DATABASE_URL"]')?.click();
    await settle();
    expect(element().textContent).toContain('No secrets yet.');
  });

  it('deploys an application and follows the deployment until it finishes', async () => {
    let deployments = [deployment('failed', 'Step pull failed.')];
    routes = {
      [`GET ${BASE}/applications/${APP}`]: () => json(application),
      [`GET ${BASE}/applications/${APP}/deployments`]: () => json({ items: deployments }),
      [`POST ${BASE}/applications/${APP}/deployments`]: () => {
        deployments = [deployment('queued'), ...deployments];
        return json({ release: {}, deployment: deployments[0] }, 201);
      },
      [`POST ${BASE}/applications/${APP}/deployments/${deployment('').id}/cancel`]: () => {
        deployments = [deployment('cancelled'), ...deployments.slice(1)];
        return json(deployments[0]);
      },
    };
    await harness.navigateByUrl(
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}`,
    );
    await settle();
    expect(element().querySelector('h1')?.textContent).toContain('billing-api');
    expect(element().querySelector('pre')?.textContent).toContain('image: nginx:1.27');
    expect(element().querySelector('table')?.textContent).toContain('Step pull failed.');

    const deploy = Array.from(element().querySelectorAll('button')).find((b) =>
      b.textContent.includes('Deploy'),
    );
    deploy?.click();
    await settle();
    expect(requests.some((r) => r.method === 'POST' && r.path.endsWith('/deployments'))).toBe(true);
    expect(element().querySelector('[role="status"]')?.textContent).toContain('queued');

    const cancel = Array.from(element().querySelectorAll('button')).find((b) =>
      b.textContent.includes('Cancel deployment'),
    );
    cancel?.click();
    await settle();
    expect(element().querySelector('table')?.textContent).toContain('cancelled');
    expect(element().querySelector('[role="status"]')).toBeNull();
  });
});
