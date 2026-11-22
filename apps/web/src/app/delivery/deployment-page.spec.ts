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

  beforeEach(async () => {
    reads = [];
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
            const path = new URL(request.url).pathname;
            reads.push(path);
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
    // Said, never faked: build and release output come later.
    expect(text).toContain('Build output and the output of the release command will appear here');
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

  it('says when the deployment is not there', async () => {
    routes[`GET ${APP_PATH}/deployments/${DEPLOYMENT}`] = () => json({ status: 404 }, 404);
    await open(`${PAGE}/deployments/${DEPLOYMENT}`);
    expect(element().querySelector('h1')?.textContent).toContain('Deployment not found');
  });

  it('opens from the application page', async () => {
    await open(`${PAGE}?tab=deployments`);
    const link = element().querySelector<HTMLAnchorElement>(
      'a[aria-label="Open deployment 4f2c1a9"]',
    );
    expect(link?.getAttribute('href')).toBe(`${PAGE}/deployments/${DEPLOYMENT}`);
  });
});
