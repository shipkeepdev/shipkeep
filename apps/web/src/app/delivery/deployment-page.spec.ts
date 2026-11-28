import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { appRoutes } from '../app.routes';
import { IDENTITY_FETCH } from '../identity/identity-api';
import { PageCrumbs } from '../dashboard/page-crumbs';
import { I18n } from '../ui/i18n';

import { EVENT_SOURCE } from './live-events';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const PROJECT = '0190f5a8-7b1c-7e2d-8f3a-0000000000bb';
const ENV = '0190f5a8-7b1c-7e2d-8f3a-0000000000cc';
const APP = '0190f5a8-7b1c-7e2d-8f3a-0000000000dd';
const DEPLOYMENT = '0190f5a8-7b1c-7e2d-8f3a-0000000000ee';
const BASE = `/api/v1/organizations/${ORG}/projects/${PROJECT}/environments/${ENV}`;
const APP_PATH = `${BASE}/applications/${APP}`;
const PAGE = `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${APP}`;
const stamp = { createdAt: '2026-11-06T09:00:00Z', updatedAt: '2026-11-06T09:00:00Z' };
const at = (second: number) => new Date(Date.UTC(2026, 10, 22, 10, 0, second)).toISOString();
const deployment = {
  id: DEPLOYMENT,
  releaseId: '4f2c1a9e-7b1c-7e2d-8f3a-0000000000ff',
  state: 'failed',
  build: false,
  release: false,
  stop: false,
  trigger: 'manual',
  actorId: null,
  error: 'The image could not be pulled.',
  startedAt: at(0),
  finishedAt: at(40),
};
const timeline = {
  steps: [
    { from: null, to: 'queued', at: at(0), reason: null },
    { from: 'queued', to: 'scheduling', at: at(1), reason: null },
    { from: 'scheduling', to: 'starting', at: at(2), reason: null },
    { from: 'starting', to: 'failed', at: at(40), reason: 'The image could not be pulled.' },
  ],
  actions: [
    {
      id: '0190f5a8-7b1c-7e2d-8f3a-000000000a01',
      nodeId: '0190f5a8-7b1c-7e2d-8f3a-000000000n01',
      nodeName: 'edge-1',
      kind: 'pullImage',
      state: 'failed',
      outcome: 'failed',
      reason: 'image_not_found',
      step: '',
      attempts: 1,
      result: null,
      deploymentId: DEPLOYMENT,
      createdAt: at(3),
      updatedAt: at(3),
      completedAt: at(3),
    },
  ],
  truncated: false,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('deployment page (#265)', () => {
  let harness: RouterTestingHarness;
  let routes: Partial<Record<string, () => Response | Promise<Response>>>;
  let reads: string[];
  /** The build output's reads, with their query. */
  let outputs: URLSearchParams[];

  beforeEach(async () => {
    reads = [];
    outputs = [];
    routes = {
      [`GET ${BASE}`]: () =>
        json({
          id: ENV,
          organizationId: ORG,
          projectId: PROJECT,
          name: 'production',
          kind: 'standard',
          failoverPolicy: 'none',
          protected: false,
          ...stamp,
        }),
      [`GET ${APP_PATH}`]: () =>
        json({
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
        }),
      [`GET ${APP_PATH}/deployments`]: () => json({ items: [deployment] }),
      [`GET ${APP_PATH}/releases`]: () =>
        json({
          items: [
            {
              id: deployment.releaseId,
              number: 4,
              image: 'nginx:1.27',
              imageDigest: null,
              config: {},
              configSha: 'a'.repeat(64),
              createdBy: null,
              createdAt: at(0),
            },
          ],
        }),
      [`GET ${APP_PATH}/deployments/${DEPLOYMENT}`]: () => json(deployment),
      [`GET ${APP_PATH}/deployments/${DEPLOYMENT}/timeline`]: () => json(timeline),
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
          useValue: (request: Request) => {
            const url = new URL(request.url);
            const path = url.pathname;
            reads.push(path);
            if (path.endsWith('/build-output')) outputs.push(url.searchParams);
            const handler = routes[`${request.method} ${path}`];
            return Promise.resolve(handler ? handler() : json({}, 404));
          },
        },
        {
          provide: EVENT_SOURCE,
          useValue: () => ({ addEventListener: () => undefined, close: () => undefined }),
        },
      ],
    });
    harness = await RouterTestingHarness.create();
  });
  // The language is kept in localStorage: put it back, or later files read French.
  afterEach(() => {
    localStorage.removeItem('shipkeep-lang');
  });

  function element(): HTMLElement {
    const found = harness.routeNativeElement;
    if (!found) throw new Error('missing route');
    return found;
  }
  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await harness.fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    harness.fixture.detectChanges();
  }
  async function open(url: string): Promise<void> {
    await harness.navigateByUrl(url);
    await settle();
  }

  it('shows each step with its time, and the agent actions between them', async () => {
    await open(`${PAGE}/deployments/${DEPLOYMENT}`);
    // Named by its release number, as the agent actions name it.
    expect(element().querySelector('h1')?.textContent).toContain('Deployment #4');
    const text = element().textContent.replace(/\s+/g, ' ');
    expect(text).toContain('failed');
    expect(text).toContain('billing-api · production · nginx:1.27 · manual');
    expect(text).toContain('Queued');
    expect(text).toContain('Placement');
    expect(text).toContain('Starting');
    expect(text).toContain('38 s');
    expect(text).toContain('PullImage → edge-1 · failed · image not found');
    expect(text).toContain('failed · The image could not be pulled.');
    // An image is not built, and this release runs no release command: no output to promise.
    expect(text).not.toContain('Build output');
    expect(text).not.toContain('release command');
    expect(outputs).toEqual([]);
    const back = [...element().querySelectorAll('a')].find(
      (a) => a.textContent.trim() === 'Application',
    );
    expect(back?.getAttribute('href')).toBe(`${PAGE}?tab=deployments`);
    // A finished deployment is read once.
    expect(reads.filter((path) => path.endsWith('/timeline'))).toHaveLength(1);
  });

  it('follows a running deployment until it finishes', async () => {
    let running = true;
    routes[`GET ${APP_PATH}/deployments/${DEPLOYMENT}`] = () =>
      json(
        running ? { ...deployment, state: 'starting', error: null, finishedAt: null } : deployment,
      );
    await open(`${PAGE}/deployments/${DEPLOYMENT}`);
    expect(element().textContent).toContain('now · starting…');
    running = false;
    await new Promise((resolve) => setTimeout(resolve, 3200));
    await settle();
    expect(element().textContent).not.toContain('now ·');
    expect(reads.filter((path) => path.endsWith('/timeline'))).toHaveLength(2);
  });

  it('reads the timeline again when it missed the step the deployment ended with', async () => {
    // Read side by side, the timeline can come from just before the deployment finished.
    let complete = false;
    routes[`GET ${APP_PATH}/deployments/${DEPLOYMENT}/timeline`] = () =>
      json(complete ? timeline : { ...timeline, steps: timeline.steps.slice(0, 3) });
    await open(`${PAGE}/deployments/${DEPLOYMENT}`);
    expect(element().textContent).not.toContain('failed · The image could not be pulled.');
    complete = true;
    await new Promise((resolve) => setTimeout(resolve, 3200));
    await settle();
    expect(element().textContent.replace(/\s+/g, ' ')).toContain(
      'failed · The image could not be pulled.',
    );
    expect(reads.filter((path) => path.endsWith('/timeline'))).toHaveLength(2);
  });

  it('reads the missing end again after a read of it fails', async () => {
    let read = 0;
    routes[`GET ${APP_PATH}/deployments/${DEPLOYMENT}/timeline`] = () => {
      read++;
      if (read === 2) return json({ status: 503 }, 503);
      return json(read === 1 ? { ...timeline, steps: timeline.steps.slice(0, 3) } : timeline);
    };
    await open(`${PAGE}/deployments/${DEPLOYMENT}`);
    await new Promise((resolve) => setTimeout(resolve, 6400));
    await settle();
    expect(element().textContent.replace(/\s+/g, ' ')).toContain(
      'failed · The image could not be pulled.',
    );
    expect(read).toBe(3);
    // Two polling rounds of 3 s each.
  }, 15_000);

  it('keeps following a running deployment after a read fails', async () => {
    let phase: 'running' | 'failing' | 'done' = 'running';
    routes[`GET ${APP_PATH}/deployments/${DEPLOYMENT}`] = () =>
      phase === 'failing'
        ? json({ status: 503 }, 503)
        : json(
            phase === 'running'
              ? { ...deployment, state: 'starting', error: null, finishedAt: null }
              : deployment,
          );
    await open(`${PAGE}/deployments/${DEPLOYMENT}`);
    phase = 'failing';
    await new Promise((resolve) => setTimeout(resolve, 3200));
    await settle();
    // What it showed stays.
    expect(element().textContent).toContain('now · starting…');
    phase = 'done';
    await new Promise((resolve) => setTimeout(resolve, 3200));
    await settle();
    expect(element().textContent).not.toContain('now ·');
    // Two polling rounds of 3 s each.
  }, 15_000);

  it('stops reading once the page is gone, even with a read on its way', async () => {
    let release: (value: undefined) => void = () => undefined;
    const held = new Promise<undefined>((resolve) => {
      release = resolve;
    });
    const path = `${APP_PATH}/deployments/${DEPLOYMENT}`;
    routes[`GET ${path}`] = async () => {
      await held;
      return json({ ...deployment, state: 'starting', error: null, finishedAt: null });
    };
    await open(`${PAGE}/deployments/${DEPLOYMENT}`);
    await open(`${PAGE}?tab=deployments`);
    release(undefined);
    await new Promise((resolve) => setTimeout(resolve, 3200));
    await settle();
    expect(reads.filter((read) => read === path)).toHaveLength(1);
  });

  it('keeps the names of the deployment it shows when an earlier one answers late', async () => {
    const OTHER = '0190f5a8-7b1c-7e2d-8f3a-0000000000d2';
    const OTHER_PATH = `${BASE}/applications/${OTHER}`;
    const named = routes[`GET ${APP_PATH}`];
    const releases = routes[`GET ${APP_PATH}/releases`];
    if (!named || !releases) throw new Error('missing route');
    let release: (value: undefined) => void = () => undefined;
    const held = new Promise<undefined>((resolve) => {
      release = resolve;
    });
    routes[`GET ${APP_PATH}`] = async () => {
      await held;
      return named();
    };
    routes[`GET ${OTHER_PATH}`] = async () => {
      const body: unknown = await (await named()).json();
      return json({ ...(body as object), id: OTHER, name: 'other-api' });
    };
    routes[`GET ${OTHER_PATH}/releases`] = releases;
    routes[`GET ${OTHER_PATH}/deployments/${DEPLOYMENT}`] = () => json(deployment);
    routes[`GET ${OTHER_PATH}/deployments/${DEPLOYMENT}/timeline`] = () => json(timeline);
    const other = `/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/applications/${OTHER}`;
    await open(`${PAGE}/deployments/${DEPLOYMENT}`);
    await open(`${other}/deployments/${DEPLOYMENT}`);
    const text = () => element().textContent.replace(/\s+/g, ' ');
    expect(text()).toContain('other-api · production');
    release(undefined);
    await settle();
    expect(text()).toContain('other-api · production');
    expect(text()).not.toContain('billing-api');
  });

  it('names the project in the trail once the shell has it, even after the title', async () => {
    let release: (value: undefined) => void = () => undefined;
    const held = new Promise<undefined>((resolve) => {
      release = resolve;
    });
    routes[`GET /api/v1/organizations/${ORG}`] = () =>
      json({ id: ORG, name: 'Acme', slug: 'acme', ...stamp });
    routes[`GET /api/v1/organizations/${ORG}/projects`] = async () => {
      await held;
      return json({
        items: [{ id: PROJECT, organizationId: ORG, name: 'Billing', slug: 'billing', ...stamp }],
        nextCursor: null,
      });
    };
    await open(`${PAGE}/deployments/${DEPLOYMENT}`);
    const trail = () =>
      TestBed.inject(PageCrumbs)
        .trail()
        .map((crumb) => crumb.label);
    expect(trail()).toEqual(['…', 'production', 'billing-api', 'Deployment #4']);
    release(undefined);
    await settle();
    expect(trail()).toEqual(['Billing', 'production', 'billing-api', 'Deployment #4']);
  });

  it('speaks French', async () => {
    TestBed.inject(I18n).use('fr');
    await open(`${PAGE}/deployments/${DEPLOYMENT}`);
    const text = element().textContent;
    expect(text).toContain('Chronologie');
    expect(text).toContain('Déploiement mis en file');
    expect(text).toContain('Démarrage');
    expect(text).toContain('billing-api');
  });

  it('names a maintenance change, and promises no build output for it (ADR 0025)', async () => {
    const entered = { ...deployment, state: 'succeeded', error: null, maintenance: 'enter' };
    routes[`GET ${APP_PATH}/deployments/${DEPLOYMENT}`] = () => json(entered);
    routes[`GET ${APP_PATH}/deployments/${DEPLOYMENT}/timeline`] = () =>
      json({
        ...timeline,
        steps: [
          { from: null, to: 'queued', at: at(0), reason: null },
          { from: 'queued', to: 'switching', at: at(1), reason: null },
          { from: 'switching', to: 'succeeded', at: at(31), reason: null },
        ],
        actions: [],
      });
    await open(`${PAGE}/deployments/${DEPLOYMENT}`);
    expect(element().querySelector('h1')?.textContent).toContain('Maintenance of #4');
    const text = element().textContent.replace(/\s+/g, ' ');
    expect(text).toContain('billing-api · production · maintenance');
    expect(text).not.toContain('nginx:1.27');
    expect(text).toContain('Maintenance queued');
    expect(text).toContain('in maintenance');
    expect(text).not.toContain('Build output');
  });

  it("shows a built deployment's output as it comes, then stops reading it", async () => {
    let running = true;
    const line = (second: number, text: string) => ({
      time: `2026-11-22T10:00:${String(second).padStart(2, '0')}.000000000Z`,
      line: text,
      truncated: false,
    });
    let lines = [line(4, '#1 [internal] load build definition from Dockerfile')];
    routes[`GET ${APP_PATH}/deployments/${DEPLOYMENT}`] = () =>
      json({
        ...deployment,
        build: true,
        state: running ? 'building' : 'failed',
        error: running ? null : 'The build failed.',
        finishedAt: running ? null : at(40),
      });
    routes[`GET ${APP_PATH}/deployments/${DEPLOYMENT}/build-output`] = () =>
      json({ kept: true, lines });
    await open(`${PAGE}/deployments/${DEPLOYMENT}`);
    const text = () => element().textContent.replace(/\s+/g, ' ');
    expect(text()).toContain('Build output');
    expect(text()).toContain('#1 [internal] load build definition from Dockerfile');
    expect(text()).toContain('now · reading the build output…');
    // The first read starts with the deployment.
    expect(outputs[0]?.get('from')).toBeNull();
    // The next one from a little before the last line; the line read again shows once.
    lines = [
      ...lines,
      line(6, '#5 [2/3] RUN npm ci'),
      line(7, 'ERROR: process "npm ci" did not complete successfully'),
    ];
    await new Promise((resolve) => setTimeout(resolve, 3200));
    await settle();
    expect(outputs[1]?.get('from')).toBe('2026-11-22T10:00:01.000Z');
    expect(text().match(/load build definition/g)).toHaveLength(1);
    expect(text()).toContain('#5 [2/3] RUN npm ci');
    expect(text()).toContain('did not complete successfully');
    // Finished: a few more reads for the lines still on their way, then none.
    running = false;
    await new Promise((resolve) => setTimeout(resolve, 3200));
    await settle();
    expect(text()).not.toContain('reading the build output');
    const finished = outputs.length;
    await new Promise((resolve) => setTimeout(resolve, 6500));
    expect(outputs.length - finished).toBeLessThanOrEqual(2);
    const settled = outputs.length;
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(outputs).toHaveLength(settled);
  }, 25_000);

  it('says the installation keeps no logs, and promises the release command output', async () => {
    routes[`GET ${APP_PATH}/deployments/${DEPLOYMENT}`] = () =>
      json({ ...deployment, build: true, release: true });
    routes[`GET ${APP_PATH}/deployments/${DEPLOYMENT}/build-output`] = () =>
      json({ kept: false, lines: [] });
    await open(`${PAGE}/deployments/${DEPLOYMENT}`);
    const text = element().textContent.replace(/\s+/g, ' ');
    expect(text).toContain('This installation keeps no logs');
    expect(text).toContain(
      'The output of the release command will appear here once it is collected.',
    );
  });

  it('says when the build output could not be read, and reads it again on request', async () => {
    let fail = true;
    routes[`GET ${APP_PATH}/deployments/${DEPLOYMENT}`] = () =>
      json({ ...deployment, build: true });
    routes[`GET ${APP_PATH}/deployments/${DEPLOYMENT}/build-output`] = () =>
      fail
        ? json({ status: 503 }, 503)
        : json({ kept: true, lines: [{ time: at(5), line: 'Step done', truncated: false }] });
    await open(`${PAGE}/deployments/${DEPLOYMENT}`);
    expect(element().textContent).toContain('The build output could not be loaded.');
    fail = false;
    const retry = [...element().querySelectorAll('button')].find(
      (button) => button.textContent.trim() === 'Retry',
    );
    retry?.click();
    await settle();
    expect(element().textContent).not.toContain('could not be loaded');
    expect(element().textContent).toContain('Step done');
  });

  it('says when the deployment is not there', async () => {
    routes[`GET ${APP_PATH}/deployments/${DEPLOYMENT}`] = () => json({ status: 404 }, 404);
    await open(`${PAGE}/deployments/${DEPLOYMENT}`);
    expect(element().querySelector('h1')?.textContent).toContain('Deployment not found');
  });

  it('opens from the application page', async () => {
    await open(`${PAGE}?tab=deployments`);
    const link = element().querySelector<HTMLAnchorElement>('a[aria-label="Open deployment #4"]');
    expect(link?.getAttribute('href')).toBe(`${PAGE}/deployments/${DEPLOYMENT}`);
    // The list names it by its release number, as the page does.
    expect(link?.textContent).toBe('#4');
  });
});
