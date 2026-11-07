import { TestBed } from '@angular/core/testing';
import {
  provideRouter,
  Router as RouterToken,
  withComponentInputBinding,
  withRouterConfig,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { appRoutes } from '../app.routes';
import { IDENTITY_FETCH } from '../identity/identity-api';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const PROJECT = '0190f5a8-7b1c-7e2d-8f3a-0000000000bb';
const ENV = '0190f5a8-7b1c-7e2d-8f3a-0000000000cc';
const APP = '0190f5a8-7b1c-7e2d-8f3a-0000000000dd';
const O = `/api/v1/organizations/${ORG}`;
const E = `${O}/projects/${PROJECT}/environments/${ENV}`;
const stamp = { createdAt: '2026-11-07T12:00:00Z', updatedAt: '2026-11-07T12:00:00Z' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const page = (items: unknown[]) => json({ items, nextCursor: null });
const node = (name: string, status: string) => ({
  id: name,
  name,
  status,
  labels: {},
  facts: {},
  leaseEpoch: 1,
  createdAt: stamp.createdAt,
  lastHeartbeatAt: null,
});

describe('organization overview', () => {
  let harness: RouterTestingHarness;
  let routes: Partial<Record<string, () => Response>>;

  beforeEach(async () => {
    routes = {
      [`GET ${O}`]: () => json({ id: ORG, name: 'Acme', slug: 'acme', ...stamp }),
      [`GET ${O}/projects`]: () =>
        page([{ id: PROJECT, organizationId: ORG, name: 'Billing', slug: 'billing', ...stamp }]),
      [`GET ${O}/projects/${PROJECT}/environments`]: () =>
        page([{ id: ENV, organizationId: ORG, projectId: PROJECT, name: 'production', ...stamp }]),
      [`GET ${E}/applications`]: () => page([{ id: APP, name: 'storefront' }]),
      [`GET ${E}/applications/${APP}/deployments`]: () =>
        page([
          {
            id: 'd2',
            releaseId: 'r2',
            state: 'failed',
            trigger: 'manual',
            error: 'No node can run replica 1 of 1 (no nodes).',
            startedAt: '2026-11-07T12:00:00Z',
            finishedAt: '2026-11-07T12:00:05Z',
          },
          {
            id: 'd1',
            releaseId: 'r1',
            state: 'succeeded',
            trigger: 'manual',
            error: null,
            startedAt: '2026-11-06T12:00:00Z',
            finishedAt: '2026-11-06T12:01:00Z',
          },
        ]),
      [`GET ${O}/nodes`]: () => page([]),
      [`GET ${O}/audit-events`]: () =>
        page([
          {
            id: 'a1',
            action: 'deployment.failed',
            actorKind: 'system',
            actorId: null,
            targetType: 'deployment',
            targetId: 'd2',
            createdAt: stamp.createdAt,
          },
        ]),
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
            const answer = routes[`${request.method} ${new URL(request.url).pathname}`];
            return Promise.resolve(answer ? answer() : json({}, 404));
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
  async function open(): Promise<void> {
    await harness.navigateByUrl(`/orgs/${ORG}`);
    for (let i = 0; i < 8; i++) {
      await harness.fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    harness.fixture.detectChanges();
  }
  const stat = (label: string) =>
    [...element().querySelectorAll('ul[aria-label="Summary"] li')]
      .find((item) => item.textContent.includes(label))
      ?.textContent.replace(/\s+/g, ' ');
  const section = (id: string) =>
    element().querySelector(`[aria-labelledby="${id}"]`)?.textContent.replace(/\s+/g, ' ') ?? '';

  it('summarizes what the API reports and says what is failing', async () => {
    await open();
    expect(stat('Apps live')).toContain('1 failing');
    expect(stat('Apps live')).toMatch(/0\s*\/\s*1/);
    expect(stat('Servers ready')).toMatch(/0\s*\/\s*0/);
    expect(section('recent-title')).toContain('storefront');
    expect(section('alerts-title')).toContain('storefront: deployment failed');
    expect(section('alerts-title')).toContain('No node can run replica 1 of 1');
    expect(section('activity-title')).toContain('deployment.failed');
  });

  it('says what to do next when no server is connected, and not otherwise', async () => {
    await open();
    expect(element().querySelector('.next-step')?.textContent).toContain('No server connected');
    expect(element().querySelector('.next-step a')?.getAttribute('href')).toBe(
      `/orgs/${ORG}/servers`,
    );

    routes[`GET ${O}/nodes`] = () => page([node('edge-1', 'ready'), node('edge-2', 'down')]);
    await harness.navigateByUrl('/orgs');
    await open();
    expect(element().querySelector('.next-step')).toBeNull();
    expect(stat('Servers ready')).toMatch(/1\s*\/\s*2/);
    expect(section('alerts-title')).toContain('edge-2 down');
  });

  it('says what this account may not see instead of showing it empty', async () => {
    routes[`GET ${O}/nodes`] = () => json({}, 404);
    routes[`GET ${O}/audit-events`] = () => json({}, 404);
    await open();
    expect(element().querySelector('.next-step')).toBeNull();
    expect(section('servers-title')).toContain('Visible to administrators');
    expect(section('activity-title')).toContain('Only admins see the audit log.');
    expect(section('recent-title')).toContain('storefront');
    expect(stat('Servers ready')).toContain('Visible to administrators');
  });

  it('still shows the rest when applications cannot be listed', async () => {
    routes[`GET ${E}/applications`] = () => json({}, 500);
    await open();
    expect(stat('Apps live')).toMatch(/0\s*\/\s*0/);
    expect(section('activity-title')).toContain('deployment.failed');
    expect(section('recent-title')).toContain('No deployment yet.');
  });

  it('never fetches for more applications than its bound', async () => {
    let requests = 0;
    routes[`GET ${E}/applications`] = () =>
      page(Array.from({ length: 100 }, (_item, index) => ({ id: `a${String(index)}`, name: 'x' })));
    const fetchRoutes = routes;
    for (let index = 0; index < 100; index++)
      fetchRoutes[`GET ${E}/applications/a${String(index)}/deployments`] = () => {
        requests++;
        return page([]);
      };
    await open();
    expect(requests).toBe(40);
  });
});

describe('landing after sign-in', () => {
  async function landing(answer: () => Response): Promise<string> {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          appRoutes,
          withComponentInputBinding(),
          withRouterConfig({ paramsInheritanceStrategy: 'always' }),
        ),
        {
          provide: IDENTITY_FETCH,
          useValue: (request: Request) =>
            Promise.resolve(
              new URL(request.url).pathname === '/api/v1/organizations' ? answer() : page([]),
            ),
        },
      ],
    });
    const harness = await RouterTestingHarness.create('/home');
    for (let i = 0; i < 6; i++) {
      await harness.fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return harness.routeDebugElement?.injector.get(RouterToken).url ?? '';
  }

  it('goes straight to the only organization', async () => {
    expect(await landing(() => page([{ id: ORG, name: 'Acme', slug: 'acme', ...stamp }]))).toBe(
      `/orgs/${ORG}`,
    );
  });
  it('lists several, or none', async () => {
    expect(
      await landing(() =>
        page([
          { id: 'a', name: 'A', slug: 'a' },
          { id: 'b', name: 'B', slug: 'b' },
        ]),
      ),
    ).toBe('/orgs');
  });
  it('asks to sign in when there is no session', async () => {
    expect(await landing(() => json({}, 401))).toBe('/auth/login');
  });
});
