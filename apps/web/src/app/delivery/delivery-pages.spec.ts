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

import { EVENT_SOURCE } from './live-events';

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

class FakeEventSource {
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listener: ((event: { data: string }) => void) | undefined;
  constructor(readonly url: string) {}
  addEventListener(_type: string, listener: (event: { data: string }) => void): void {
    this.listener = listener;
  }
  emit(data: unknown): void {
    this.listener?.({ data: JSON.stringify(data) });
  }
  close(): void {
    this.closed = true;
  }
}

describe('delivery screens', () => {
  let harness: RouterTestingHarness;
  let sources: FakeEventSource[];
  let requests: { method: string; path: string; body: unknown }[];
  let routes: Partial<Record<string, () => Response | Promise<Response>>>;
  /** Query of the request being answered, for routes that page. */
  let query: URLSearchParams;

  beforeEach(async () => {
    requests = [];
    sources = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          appRoutes,
          withComponentInputBinding(),
          withRouterConfig({ paramsInheritanceStrategy: 'always' }),
        ),
        {
          provide: EVENT_SOURCE,
          useValue: (url: string) => {
            const source = new FakeEventSource(url);
            sources.push(source);
            return source;
          },
        },
        {
          provide: IDENTITY_FETCH,
          useValue: async (request: Request) => {
            const path = new URL(request.url).pathname;
            query = new URL(request.url).searchParams;
            const text = request.method === 'GET' ? '' : await request.clone().text();
            requests.push({
              method: request.method,
              path,
              body: text ? (JSON.parse(text) as unknown) : undefined,
            });
            const handler = routes[`${request.method} ${path}`];
            // The dashboard frame reads the organization on every page.
            if (!handler && path === `/api/v1/organizations/${ORG}`)
              return json({ id: ORG, name: 'Acme', slug: 'acme' });
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

  async function click(label: string): Promise<void> {
    const button = Array.from(element().querySelectorAll('button')).find(
      (b) => b.textContent.trim() === label,
    );
    if (!button) throw new Error(`missing button ${label}`);
    button.click();
    await settle();
  }

  const deploymentsText = () => element().querySelector('#panel-deployments')?.textContent ?? '';
  const configText = () => element().querySelector('#panel-config')?.textContent ?? '';

  async function openEditor(): Promise<void> {
    routes = {
      [`GET ${BASE}/applications/${APP}`]: () => json(application),
      [`GET ${BASE}/applications/${APP}/deployments`]: () => json({ items: [] }),
    };
    await harness.navigateByUrl(
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}?section=yml`,
    );
    await settle();
  }

  it('validates and reviews YAML, invalidates the preview on edits, and saves without deploying', async () => {
    await openEditor();
    const draft = () =>
      element().querySelector<HTMLTextAreaElement>('#configuration-draft')?.value ?? '';
    const initial = draft();
    for (const invalid of [
      'name: [',
      initial.replace('billing-api', 'renamed'),
      initial + '\nrun: {}',
    ]) {
      fill('configuration-draft', invalid);
      await submit(0);
      expect(element().querySelector('#configuration-draft')?.getAttribute('aria-invalid')).toBe(
        'true',
      );
      expect(requests.some((r) => r.method === 'POST')).toBe(false);
    }
    fill('configuration-draft', initial.replace('port: 80', 'port: 8080'));
    await submit(0);
    expect(element().querySelector('pre')?.textContent).toContain('-   port: 80');
    expect(element().querySelector('pre')?.textContent).toContain('+   port: 8080');
    fill('configuration-draft', initial.replace('port: 80', 'port: 8081'));
    await settle();
    expect(element().querySelector('pre')).toBeNull();
    await submit(0);
    const updated = {
      ...application,
      configSha: 'b'.repeat(64),
      config: { ...application.config, run: { port: 8081 } },
    };
    routes[`POST ${BASE}/applications/${APP}/config`] = () => json(updated);
    await click('Save configuration');
    expect(requests.filter((r) => r.method === 'POST')).toEqual([
      {
        method: 'POST',
        path: `${BASE}/applications/${APP}/config`,
        body: { expectedConfigSha: application.configSha, config: updated.config },
      },
    ]);
    expect(element().textContent).toContain('Configuration saved.');
    expect(element().textContent).toContain('bbbbbbbbbbbb');
  });

  it('preserves a conflicting draft, retries reload failures and requires review against the new hash', async () => {
    await openEditor();
    const initial =
      element().querySelector<HTMLTextAreaElement>('#configuration-draft')?.value ?? '';
    const draft = initial.replace('port: 80', 'port: 8080');
    fill('configuration-draft', draft);
    await submit(0);
    routes[`POST ${BASE}/applications/${APP}/config`] = () => json({}, 409);
    await click('Save configuration');
    expect(element().textContent).toContain('Your draft has been kept.');
    await click('Save configuration');
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    routes[`GET ${BASE}/applications/${APP}`] = () => json({}, 503);
    await click('Load latest version');
    expect(element().textContent).toContain('temporarily unavailable');
    expect(element().querySelector<HTMLTextAreaElement>('#configuration-draft')?.value).toBe(draft);
    const latest = {
      ...application,
      configSha: 'b'.repeat(64),
      config: { ...application.config, run: { port: 81 } },
    };
    routes[`GET ${BASE}/applications/${APP}`] = () => json(latest);
    await click('Load latest version');
    expect(element().querySelector('pre')).toBeNull();
    await submit(0);
    expect(element().querySelector('pre')?.textContent).toContain('-   port: 81');
    routes[`POST ${BASE}/applications/${APP}/config`] = () => json(latest);
    await click('Save configuration');
    expect(requests.filter((r) => r.method === 'POST').at(-1)?.body).toMatchObject({
      expectedConfigSha: latest.configSha,
      config: { run: { port: 8080 } },
    });
  });

  it('ignores an application load that finishes after navigation to another application', async () => {
    let resolveOld: (response: Response) => void = () => undefined;
    routes = {
      [`GET ${BASE}/applications/${APP}`]: () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    };
    const next = APP.replace(/dd$/, 'ab');
    routes[`GET ${BASE}/applications/${next}`] = () =>
      json({ ...application, id: next, name: 'next-app' });
    routes[`GET ${BASE}/applications/${next}/deployments`] = () => json({ items: [] });
    await harness.navigateByUrl(
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}`,
    );
    await settle();
    await harness.navigateByUrl(
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${next}`,
    );
    await settle();
    resolveOld(json(application));
    await settle();
    expect(element().querySelector('h1')?.textContent).toBe('next-app');
  });

  it('offers a rollback only for earlier versions that ran, and follows it', async () => {
    const older = { ...deployment('succeeded'), id: 'd-old', releaseId: 'r-old' };
    const current = { ...deployment('succeeded'), id: 'd-new', releaseId: 'r-new' };
    const broken = {
      ...deployment('failed', 'Step pull failed.'),
      id: 'd-bad',
      releaseId: 'r-bad',
    };
    let deployments = [broken, current, older];
    routes = {
      [`GET ${BASE}/applications/${APP}`]: () => json(application),
      [`GET ${BASE}/applications/${APP}/deployments`]: () => json({ items: deployments }),
      [`POST ${BASE}/applications/${APP}/deployments/d-old/rollback`]: () => {
        deployments = [
          { ...deployment('queued'), id: 'd-roll', releaseId: 'r-roll', trigger: 'rollback' },
          ...deployments,
        ];
        return json({ release: {}, deployment: deployments[0] }, 201);
      },
    };
    await harness.navigateByUrl(
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}`,
    );
    await settle();
    const rollbacks = () =>
      Array.from(element().querySelectorAll('#panel-deployments button')).filter((b) =>
        b.textContent.includes('Roll back'),
      );
    // Neither the serving version nor the failed one can be rolled back to.
    expect(rollbacks()).toHaveLength(1);
    (rollbacks()[0] as HTMLButtonElement).click();
    await settle();
    expect(requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual([
      `${BASE}/applications/${APP}/deployments/d-old/rollback`,
    ]);
    expect(element().querySelector('[role="status"]')?.textContent).toContain('queued');
    expect(deploymentsText()).toContain('rollback');
    expect((rollbacks()[0] as HTMLButtonElement).disabled).toBe(true);
  });

  describe('danger zone (#256)', () => {
    const replica = {
      id: 'a-1',
      releaseId: 'r-new',
      replica: 0,
      nodeId: 'n-1',
      nodeName: 'edge-1',
      container: 'sk-billing-api-0000000000dd-r1-0',
      state: 'running',
      observedAt: '2026-11-06T09:00:00Z',
    };
    const danger = `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}?section=danger`;
    const button = (label: string) =>
      Array.from(element().querySelectorAll('#panel-config button')).find(
        (b) => b.textContent.trim() === label,
      ) as HTMLButtonElement | undefined;
    const posts = () => requests.filter((r) => r.method === 'POST').map((r) => r.path);

    it('stops a running application after asking once more, and never offers to delete it', async () => {
      const live = { ...deployment('succeeded'), id: 'd-new', releaseId: 'r-new', stop: false };
      let deployments: unknown[] = [live];
      let replicas: unknown[] = [replica];
      routes = {
        [`GET ${BASE}/applications/${APP}`]: () => json(application),
        [`GET ${BASE}/applications/${APP}/deployments`]: () => json({ items: deployments }),
        [`GET ${BASE}/applications/${APP}/replicas`]: () => json({ items: replicas }),
        [`POST ${BASE}/applications/${APP}/deployments/d-stop/rollback`]: () =>
          json(
            { release: { id: 'r-start' }, deployment: { ...deployment('queued'), id: 'd-start' } },
            201,
          ),
        [`POST ${BASE}/applications/${APP}/stop`]: () => {
          const stopping = {
            ...deployment('queued'),
            id: 'd-stop',
            releaseId: 'r-new',
            stop: true,
          };
          deployments = [stopping, live];
          return json(stopping, 201);
        },
      };
      await harness.navigateByUrl(danger);
      await settle();
      // No sample row is left: only what the control plane can do.
      expect(configText()).not.toContain('maintenance');
      expect(configText()).toContain('Stop it first');
      expect(button('Delete')?.disabled).toBe(true);
      expect(button('Stop')?.disabled).toBe(false);

      await click('Stop');
      // Nothing is sent before the second click.
      expect(posts()).toEqual([]);
      await click('Keep it running');
      expect(button('Stop')).toBeDefined();
      await click('Stop');
      await click('Stop it now');
      expect(posts()).toEqual([`${BASE}/applications/${APP}/stop`]);
      // The page follows the stop like any deployment, and says what it is.
      expect(element().querySelector('[role="status"]')?.textContent).toContain('stopping');
      expect(button('Stop')?.disabled).toBe(true);

      deployments = [
        { ...deployment('succeeded'), id: 'd-stop', releaseId: 'r-new', stop: true },
        live,
      ];
      replicas = [];
      // The agents finished: the page learns it from the live events, as for any deployment.
      sources[0]?.emit({ applicationId: APP });
      await settle();
      expect(element().querySelector('.page-head .pill')?.textContent).toContain('stopped');
      expect(button('Delete')?.disabled).toBe(false);
      // The version that ran before the stop can be started again; the stop itself cannot.
      expect(
        Array.from(element().querySelectorAll('#panel-deployments button')).filter((b) =>
          b.textContent.includes('Roll back'),
        ),
      ).toHaveLength(1);
      // The header and the danger zone offer to start that version, not to roll back to it.
      const head = element().querySelector('.page-head')?.textContent ?? '';
      expect(head).toContain('Start r-new');
      expect(head).not.toContain('Roll back');
      expect(configText()).toContain(
        'Starting it deploys again the version it ran before the stop.',
      );
      expect(button('Start')?.disabled).toBe(false);
      expect(button('Stop')).toBeUndefined();
      // Starting deploys again the version the stop stopped.
      await click('Start');
      expect(posts().at(-1)).toBe(`${BASE}/applications/${APP}/deployments/d-stop/rollback`);
      expect(deploymentsText()).toContain('stop');
      // The deployment card shows the stop as a stop, with its own two steps.
      const card = element().querySelector('#panel-deployments .card')?.textContent ?? '';
      expect(card).toContain('Stop of r-new');
      expect(card).toContain('stop requested');
      expect(card).toContain('Routes and replicas removed');
      expect(card).not.toContain('Health check');
      expect(card).not.toContain('live');
    });

    it('deletes a stopped application once its exact name is typed, then leaves the page', async () => {
      routes = {
        [`GET ${BASE}/applications/${APP}`]: () => json(application),
        [`GET ${BASE}/applications/${APP}/deployments`]: () => json({ items: [] }),
        [`GET ${BASE}/applications/${APP}/replicas`]: () => json({ items: [] }),
        [`POST /api/v1/organizations/${ORG}/confirmations`]: () =>
          json(
            { id: 'c-1', token: 'signed.confirmation.token', expiresAt: '2026-11-06T09:05:00Z' },
            201,
          ),
        [`POST ${BASE}/applications/${APP}/delete`]: () => new Response(null, { status: 204 }),
        [`GET ${BASE}`]: () => json(environment),
        [`GET ${BASE}/applications`]: () => json({ items: [] }),
      };
      await harness.navigateByUrl(danger);
      await settle();
      await click('Delete');
      const confirm = () => button('Delete the application');
      expect(confirm()?.disabled).toBe(true);
      fill('confirm-name', 'billing');
      harness.fixture.detectChanges();
      expect(confirm()?.disabled).toBe(true);
      expect(posts()).toEqual([]);
      fill('confirm-name', 'billing-api');
      harness.fixture.detectChanges();
      expect(confirm()?.disabled).toBe(false);
      await submit(0);

      const sent = requests.filter((r) => r.method === 'POST');
      expect(sent.map((r) => [r.path, r.body])).toEqual([
        [
          `/api/v1/organizations/${ORG}/confirmations`,
          { action: 'application.delete', target: APP, name: 'billing-api' },
        ],
        [`${BASE}/applications/${APP}/delete`, { confirmation: 'signed.confirmation.token' }],
      ]);
      // Back to the environment the application was in.
      expect(TestBed.inject(Router).url).toBe(
        `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}`,
      );
    });

    it('lists a stopped application as stopped, never as live', async () => {
      routes = {
        [`GET ${BASE}`]: () => json(environment),
        [`GET ${BASE}/applications`]: () => json({ items: [application] }),
        [`GET ${BASE}/applications/${APP}/deployments`]: () =>
          json({
            items: [
              { ...deployment('succeeded'), id: 'd-stop', releaseId: 'r-new', stop: true },
              { ...deployment('succeeded'), id: 'd-new', releaseId: 'r-new', stop: false },
            ],
          }),
      };
      await harness.navigateByUrl(`/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}`);
      await settle();
      const row = Array.from(element().querySelectorAll('.grid-table')).find((r) =>
        r.textContent.includes('billing-api'),
      );
      expect(row?.textContent).toContain('stopped');
      expect(row?.textContent).not.toContain('live');
    });

    it('lets a stop be asked again after the server refused the first one', async () => {
      const live = { ...deployment('succeeded'), id: 'd-new', releaseId: 'r-new', stop: false };
      let refusals = 1;
      routes = {
        [`GET ${BASE}/applications/${APP}`]: () => json(application),
        [`GET ${BASE}/applications/${APP}/deployments`]: () => json({ items: [live] }),
        [`GET ${BASE}/applications/${APP}/replicas`]: () => json({ items: [replica] }),
        [`POST ${BASE}/applications/${APP}/stop`]: () =>
          refusals-- > 0
            ? json({ code: 'deployment_in_progress', title: 'Conflict', status: 409 }, 409)
            : json({ ...deployment('queued'), id: 'd-stop', releaseId: 'r-new', stop: true }, 201),
      };
      await harness.navigateByUrl(danger);
      await settle();
      await click('Stop');
      await click('Stop it now');
      expect(posts()).toHaveLength(1);
      expect(element().querySelector('#panel-config [role="alert"]')).not.toBeNull();
      // A refusal must not leave the button dead: asking again starts a new attempt.
      await click('Stop');
      expect(element().querySelector('#panel-config [role="alert"]')).toBeNull();
      await click('Stop it now');
      expect(posts()).toHaveLength(2);
    });

    it('keeps the application and says why when the server refuses the deletion', async () => {
      routes = {
        [`GET ${BASE}/applications/${APP}`]: () => json(application),
        [`GET ${BASE}/applications/${APP}/deployments`]: () => json({ items: [] }),
        [`GET ${BASE}/applications/${APP}/replicas`]: () => json({ items: [] }),
        [`POST /api/v1/organizations/${ORG}/confirmations`]: () =>
          json({ code: 'confirmation_name_mismatch', title: 'Bad Request', status: 400 }, 400),
      };
      await harness.navigateByUrl(danger);
      await settle();
      await click('Delete');
      fill('confirm-name', 'billing-api');
      await submit(0);
      expect(posts()).toEqual([`/api/v1/organizations/${ORG}/confirmations`]);
      expect(element().querySelector('[role="alert"]')).not.toBeNull();
      expect(TestBed.inject(Router).url).toContain(`/applications/${APP}`);
      expect(button('Delete')?.disabled).toBe(false);
    });
  });

  it('shows where each domain points, and whether a server running the app answers', async () => {
    const domain = (hostname: string, status: string, match: string, addresses: string[] = []) => ({
      hostname,
      status,
      addresses,
      match,
    });
    routes = {
      [`GET ${BASE}/applications/${APP}`]: () => json(application),
      [`GET ${BASE}/applications/${APP}/deployments`]: () => json({ items: [] }),
      [`GET ${BASE}/applications/${APP}/domains`]: () =>
        json({
          items: [
            domain('a.example.com', 'public', 'serving', ['203.0.113.4']),
            domain('b.example.com', 'private', 'elsewhere'),
            domain('c.example.com', 'none', 'not_running'),
            domain('d.example.com', 'public', 'partial', ['203.0.113.4', '198.51.100.7']),
            domain('e.example.com', 'public', 'unknown', ['198.51.100.7']),
            domain('f.example.com', 'unknown', 'unknown'),
          ],
        }),
    };
    await harness.navigateByUrl(
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}?section=domains`,
    );
    await settle();
    const list = configText();
    expect(list).toContain('a.example.com');
    expect(list).toContain('203.0.113.4');
    expect(list).toContain('private address');
    expect(list).toContain('no record');
    const rows = Array.from(element().querySelectorAll('.grid-table'), (row) => row.textContent);
    const rowOf = (hostname: string) => rows.find((row) => row.includes(hostname)) ?? '';
    expect(rowOf('a.example.com')).toContain('a server running it');
    expect(rowOf('b.example.com')).toContain('no server running it');
    expect(rowOf('c.example.com')).toContain('no server runs it yet');
    expect(rowOf('d.example.com')).toContain('partly a server running it');
    expect(rowOf('e.example.com')).toContain('cannot tell: address not set');
    expect(rowOf('f.example.com')).toContain('cannot tell yet');
  });

  it('reloads deployments when a live event names this application, and closes on leaving', async () => {
    let deployments = [deployment('succeeded')];
    routes = {
      [`GET ${BASE}/applications/${APP}`]: () => json(application),
      [`GET ${BASE}/applications/${APP}/deployments`]: () => json({ items: deployments }),
    };
    await harness.navigateByUrl(
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}`,
    );
    await settle();
    expect(sources.map((source) => new URL(source.url).pathname)).toEqual([`${BASE}/events`]);
    deployments = [deployment('failed', 'Live failure.')];
    sources[0]?.emit({ applicationId: 'another-application' });
    await settle();
    expect(deploymentsText()).not.toContain('Live failure.');
    sources[0]?.emit({ applicationId: APP });
    await settle();
    expect(deploymentsText()).toContain('Live failure.');
    await harness.navigateByUrl('/orgs');
    expect(sources[0]?.closed).toBe(true);
  });

  describe('the badge follows the replicas once a deployment succeeded (#366)', () => {
    const replica = (index: number, state: string | null) => ({
      id: `a${String(index)}`,
      releaseId: 'r-new',
      replica: index,
      nodeId: 'n1',
      nodeName: 'edge-1',
      container: `sk-web-r-new-${String(index)}`,
      state,
      observedAt: '2026-11-07T12:00:00Z',
    });
    const badge = () => element().querySelector('.page-head .pill')?.textContent ?? '';
    const show = async (replicas: readonly ReturnType<typeof replica>[]) => {
      routes = {
        [`GET ${BASE}/applications/${APP}`]: () => json(application),
        [`GET ${BASE}/applications/${APP}/deployments`]: () =>
          json({ items: [{ ...deployment('succeeded'), id: 'd-new', releaseId: 'r-new' }] }),
        [`GET ${BASE}/applications/${APP}/replicas`]: () => json({ items: replicas }),
      };
      await harness.navigateByUrl(
        `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}`,
      );
      await settle();
    };

    it('says not running when no replica runs, like the line under it', async () => {
      await show([replica(0, 'exited')]);
      expect(badge()).toContain('not running');
      expect(badge()).not.toContain('live');
      expect(element().querySelector('.page-head')?.textContent).toContain(
        '0 of 1 replica running',
      );
    });

    it('says degraded when only some replicas run', async () => {
      await show([replica(0, 'running'), replica(1, 'exited')]);
      expect(badge()).toContain('degraded');
    });

    it('says live when every replica runs', async () => {
      await show([replica(0, 'running'), replica(1, 'running')]);
      expect(badge()).toContain('live');
    });
  });

  it('shows replicas with their server and what the agent last saw', async () => {
    routes = {
      [`GET ${BASE}/applications/${APP}`]: () => json(application),
      [`GET ${BASE}/applications/${APP}/deployments`]: () => json({ items: [] }),
      [`GET ${BASE}/applications/${APP}/replicas`]: () =>
        json({
          items: [
            {
              id: 'a1',
              releaseId: 'r1',
              replica: 0,
              nodeId: 'n1',
              nodeName: 'edge-1',
              container: 'sk-web-r1-0',
              state: 'running',
              observedAt: '2026-11-07T12:00:00Z',
            },
            {
              id: 'a2',
              releaseId: 'r1',
              replica: 1,
              nodeId: 'n2',
              nodeName: 'edge-2',
              container: 'sk-web-r1-1',
              state: null,
              observedAt: null,
            },
          ],
        }),
    };
    await harness.navigateByUrl(
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}?section=placement`,
    );
    await settle();
    const table = configText();
    expect(table).toContain('edge-1');
    expect(table).toContain('running');
    expect(table).toContain('not reported yet');
  });

  it('lists agent actions with their server, result and refusal, pages them and links their deployment', async () => {
    const id = (n: number) => `0190f5a8-7b1c-7e2d-8f3a-${String(n).padStart(12, '0')}`;
    const older = {
      ...deployment('succeeded'),
      id: id(800),
      releaseId: `abcdef1${id(801).slice(7)}`,
    };
    const action = (n: number, fields: object = {}) => ({
      id: id(n),
      kind: 'startContainer',
      nodeId: id(900),
      nodeName: 'srv-par-1',
      state: 'succeeded',
      step: 'started',
      attempts: 1,
      outcome: 'succeeded',
      reason: null,
      result: null,
      deploymentId: older.id,
      createdAt: '2026-11-11T10:12:58Z',
      updatedAt: '2026-11-11T10:12:58Z',
      completedAt: '2026-11-11T10:12:58Z',
      ...fields,
    });
    let failing = true;
    routes = {
      [`GET ${BASE}/applications/${APP}`]: () => json(application),
      [`GET ${BASE}/applications/${APP}/deployments`]: () =>
        json({ items: [deployment('succeeded'), older] }),
      [`GET ${BASE}/applications/${APP}/releases`]: () =>
        json({ items: [{ id: older.releaseId, number: 4, image: 'nginx:1.27', ...stamp }] }),
      [`GET ${BASE}/applications/${APP}/agent-actions`]: () => {
        if (failing) return json({ status: 503 }, 503);
        return query.get('cursor')
          ? json({
              items: [
                action(1, { kind: 'pullImage', nodeName: 'srv-fra-2', deploymentId: id(700) }),
              ],
              nextCursor: null,
            })
          : json({
              items: [
                action(3, { kind: 'upsertRoute' }),
                action(2, {
                  kind: 'stopContainer',
                  nodeName: 'srv-fra-4',
                  state: 'failed',
                  outcome: 'refused',
                  reason: 'stale_lease_epoch',
                }),
              ],
              nextCursor: id(2),
            });
      },
    };
    await harness.navigateByUrl(
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}?section=actions`,
    );
    await settle();
    expect(element().querySelector('#panel-config [role="alert"]')?.textContent).toContain(
      'temporarily unavailable',
    );
    failing = false;
    await click('Retry');
    const rows = () =>
      Array.from(element().querySelectorAll('[role="table"] [role="row"]'))
        .slice(1)
        .map((row) =>
          Array.from(row.querySelectorAll('[role="cell"]')).map((cell) =>
            cell.textContent.replace(/\s+/g, ' ').trim(),
          ),
        );
    expect(rows().map((cells) => cells.slice(1))).toEqual([
      // Phones show the deployment after the server, and hide its column (CSS, not in jsdom).
      ['UpsertRoute', 'srv-par-1 · #4', 'ok', '#4'],
      ['StopContainer', 'srv-fra-4 · #4', 'refused · lease superseded', '#4'],
    ]);
    // Real data: the sample rows and the Preview label are gone from this section.
    expect(element().querySelector('#panel-config sk-preview-pill')).toBeNull();
    expect(configText()).not.toContain('srv-ams-3');
    expect(requests.filter((r) => r.path.endsWith('/agent-actions')).length).toBeGreaterThan(0);

    await click('Load older actions');
    expect(rows().map((cells) => cells[1])).toEqual(['UpsertRoute', 'StopContainer', 'PullImage']);
    // A deployment the page does not know shows the end of its id.
    expect(rows()[2]?.[4]).toBe('000700');
    expect(query.get('cursor')).toBe(id(2));
    expect(element().textContent).not.toContain('Load older actions');

    // The deployment link opens that deployment, not the latest one.
    const link = element().querySelector<HTMLAnchorElement>('[role="cell"] a');
    expect(link?.getAttribute('href')).toContain(`deployment=${older.id}`);
    await harness.navigateByUrl(link?.getAttribute('href') ?? '');
    await settle();
    expect(element().querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      'Deployments',
    );
    // Named by its release number, like the agent actions and the deployment page (#265).
    expect(deploymentsText()).toContain('Deployment #4');
    expect(deploymentsText()).not.toContain('Deployment 0190f5a');
  });

  it('reloads only the newest agent actions once per live update, keeping older pages', async () => {
    const id = (n: number) => `0190f5a8-7b1c-7e2d-8f3a-${String(n).padStart(12, '0')}`;
    const action = (n: number) => ({
      id: id(n),
      kind: 'startContainer',
      nodeId: id(900),
      nodeName: 'srv-par-1',
      state: 'succeeded',
      step: 'started',
      attempts: 1,
      outcome: 'succeeded',
      reason: null,
      result: null,
      deploymentId: null,
      createdAt: '2026-11-11T10:12:58Z',
      updatedAt: '2026-11-11T10:12:58Z',
      completedAt: '2026-11-11T10:12:58Z',
    });
    // Newest first: 21 to 2 on the first page, 1 on the older one; 22 arrives later.
    let newest = 21;
    routes = {
      [`GET ${BASE}/applications/${APP}`]: () => json(application),
      [`GET ${BASE}/applications/${APP}/deployments`]: () =>
        json({ items: [deployment('succeeded')] }),
      [`GET ${BASE}/applications/${APP}/agent-actions`]: () =>
        query.get('cursor')
          ? json({ items: [action(1)], nextCursor: null })
          : json({
              items: Array.from({ length: 20 }, (_, i) => action(newest - i)),
              nextCursor: id(newest - 19),
            }),
    };
    await harness.navigateByUrl(
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}?section=actions`,
    );
    await settle();
    await click('Load older actions');
    const shown = () => element().querySelectorAll('[role="table"] [role="row"]').length - 1;
    const loads = () => requests.filter((r) => r.path.endsWith('/agent-actions')).length;
    expect(shown()).toBe(21);
    const before = loads();
    newest = 22;
    sources[0]?.emit({ applicationId: APP });
    await settle();
    await settle();
    // One newest-page request per update: the merge must not trigger another load.
    expect(loads() - before).toBe(1);
    expect(shown()).toBe(22);
  });

  it('says when an application has no agent action yet', async () => {
    routes = {
      [`GET ${BASE}/applications/${APP}`]: () => json(application),
      [`GET ${BASE}/applications/${APP}/deployments`]: () => json({ items: [] }),
      [`GET ${BASE}/applications/${APP}/agent-actions`]: () =>
        json({ items: [], nextCursor: null }),
    };
    await harness.navigateByUrl(
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}?section=actions`,
    );
    await settle();
    expect(configText()).toContain('No agent action yet.');
    expect(configText()).not.toContain('Load older actions');
  });

  it('charts the metrics of the period chosen, and says when the installation keeps none', async () => {
    const t0 = 1_795_000_000;
    const series = (values: number[], labels: Record<string, string> = {}) => ({
      labels,
      points: values.map((v, index) => ({ t: t0 + index * 30, v })),
    });
    let kept = true;
    routes = {
      [`GET ${BASE}/applications/${APP}`]: () => json(application),
      [`GET ${BASE}/applications/${APP}/deployments`]: () => json({ items: [] }),
      [`GET ${BASE}/applications/${APP}/metrics`]: () =>
        json({
          kept,
          range: query.get('range'),
          stepSeconds: 30,
          from: new Date(t0 * 1000).toISOString(),
          to: new Date((t0 + 60) * 1000).toISOString(),
          cpu: kept ? [series([0.01, 0.25, 0.5])] : [],
          memory: kept ? [series([64 * 1024 ** 2, 128 * 1024 ** 2, 256 * 1024 ** 2])] : [],
          requests: kept
            ? [series([2, 3, 4], { status: '2xx' }), series([0, 1, 1], { status: '5xx' })]
            : [],
          duration: [],
        }),
    };
    const metricsCalls = () => requests.filter((r) => r.path.endsWith('/metrics'));
    await harness.navigateByUrl(
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}`,
    );
    await settle();
    // Nothing is read while the tab is closed.
    expect(metricsCalls()).toHaveLength(0);
    element().querySelector<HTMLButtonElement>('#tab-metrics')?.click();
    await settle();
    const panel = () => element().querySelector('#panel-metrics')?.textContent ?? '';
    expect(metricsCalls()).toHaveLength(1);
    expect(panel()).toContain('0.50 CPU');
    expect(panel()).toContain('256 MiB');
    // Requests add every status class; the latest point is 4 + 1.
    expect(panel()).toContain('5.0/s');
    expect(panel()).toContain('No data for this period yet.');
    expect(element().querySelectorAll('#panel-metrics svg path').length).toBe(4);

    await click('24h');
    expect(query.get('range')).toBe('24h');

    kept = false;
    await click('7d');
    expect(panel()).toContain('This installation keeps no metrics');
  });

  it('clears the charts of a period as soon as another is chosen', async () => {
    let release: (() => void) | undefined;
    const answer = (cpu: number) =>
      json({
        kept: true,
        range: query.get('range'),
        stepSeconds: 30,
        from: new Date(1_795_000_000_000).toISOString(),
        to: new Date(1_795_000_060_000).toISOString(),
        cpu: [{ labels: {}, points: [{ t: 1_795_000_000, v: cpu }] }],
        memory: [],
        requests: [],
        duration: [],
      });
    routes = {
      [`GET ${BASE}/applications/${APP}`]: () => json(application),
      [`GET ${BASE}/applications/${APP}/deployments`]: () => json({ items: [] }),
      [`GET ${BASE}/applications/${APP}/metrics`]: () =>
        query.get('range') === '24h'
          ? new Promise<Response>((resolve) => {
              release = () => {
                resolve(answer(0.5));
              };
            })
          : answer(0.25),
    };
    await harness.navigateByUrl(
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}`,
    );
    await settle();
    element().querySelector<HTMLButtonElement>('#tab-metrics')?.click();
    await settle();
    const panel = () => element().querySelector('#panel-metrics')?.textContent ?? '';
    expect(panel()).toContain('0.25 CPU');
    await click('24h');
    // The 1 h charts are gone while the 24 h answer is on its way.
    expect(panel()).not.toContain('0.25 CPU');
    expect(panel()).toContain('Loading…');
    release?.();
    await settle();
    expect(panel()).toContain('0.50 CPU');
  });

  it('compares a release with the previous one', async () => {
    const release = (number: number, port: number) => ({
      id: `r${String(number)}`,
      number,
      image: 'nginx:1.27',
      imageDigest: null,
      config: { ...application.config, run: { port } },
      configSha: 'a'.repeat(64),
      createdBy: null,
      createdAt: '2026-11-07T12:00:00Z',
    });
    routes = {
      [`GET ${BASE}/applications/${APP}`]: () => json(application),
      [`GET ${BASE}/applications/${APP}/deployments`]: () => json({ items: [] }),
      [`GET ${BASE}/applications/${APP}/releases`]: () =>
        json({ items: [release(2, 8080), release(1, 80)] }),
    };
    await harness.navigateByUrl(
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}?section=rollback`,
    );
    await settle();
    const list = () => element().querySelector('ul[aria-label="Releases"]');
    // The oldest release has nothing to compare with.
    expect(list()?.querySelectorAll('button')).toHaveLength(1);
    list()?.querySelector('button')?.click();
    await settle();
    const diff = element().querySelector('pre[aria-label="Changes in release 2"]')?.textContent;
    expect(diff).toContain('-   port: 80');
    expect(diff).toContain('+   port: 8080');
  });

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
    expect(element().textContent).toContain('No application yet.');

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
    expect(element().querySelector('#panel-applications')?.textContent).toContain('billing-api');
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
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}?section=yml`,
    );
    await settle();
    expect(element().querySelector('h1')?.textContent).toContain('billing-api');
    expect(element().querySelector<HTMLTextAreaElement>('#configuration-draft')?.value).toContain(
      'image: nginx:1.27',
    );
    expect(deploymentsText()).toContain('Step pull failed.');

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
    expect(deploymentsText()).toContain('cancelled');
    expect(element().querySelector('[role="status"]')).toBeNull();
  });

  it('deploys again after the server refused for a missing secret', async () => {
    // The first refusal is the common one: the configuration names a secret that is not set yet.
    let refusals = 1;
    let deployments: unknown[] = [];
    routes = {
      [`GET ${BASE}/applications/${APP}`]: () => json(application),
      [`GET ${BASE}/applications/${APP}/deployments`]: () => json({ items: deployments }),
      [`POST ${BASE}/applications/${APP}/deployments`]: () => {
        if (refusals-- > 0)
          return json({ code: 'secrets_missing', title: 'Conflict', status: 409 }, 409);
        deployments = [deployment('queued')];
        return json({ release: {}, deployment: deployments[0] }, 201);
      },
    };
    await harness.navigateByUrl(
      `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}`,
    );
    await settle();
    const deploy = () =>
      Array.from(element().querySelectorAll('button')).find((b) =>
        b.textContent.includes('Deploy'),
      );
    const sent = () =>
      requests.filter((r) => r.method === 'POST' && r.path.endsWith('/deployments')).length;
    deploy()?.click();
    await settle();
    expect(sent()).toBe(1);
    expect(element().querySelector('[role="alert"]')).not.toBeNull();
    // Once the secret is set, the same button must work without reloading the page.
    deploy()?.click();
    await settle();
    expect(sent()).toBe(2);
    expect(element().querySelector('[role="status"]')?.textContent).toContain('queued');
  });
});
