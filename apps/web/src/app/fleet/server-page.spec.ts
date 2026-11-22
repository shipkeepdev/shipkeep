import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { appRoutes } from '../app.routes';
import { IDENTITY_FETCH } from '../identity/identity-api';
import { I18n } from '../ui/i18n';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const NODE = '0190f5a8-7b1c-7e2d-8f3a-0000000000bb';
const BASE = `/api/v1/organizations/${ORG}`;
const node = {
  id: NODE,
  name: 'edge-1',
  status: 'ready',
  labels: { region: 'par' },
  facts: {
    hostname: 'edge-1.example.com',
    os: 'Ubuntu',
    os_version: '24.04',
    cpu_count: 4,
    memory_bytes: 8 * 2 ** 30,
    agent_version: '0.1.0-alpha.3',
  },
  publicAddresses: [] as string[],
  leaseEpoch: 3,
  createdAt: '2026-11-06T09:00:00Z',
  lastHeartbeatAt: new Date(Date.now() - 3000).toISOString(),
};
const replica = {
  id: '0190f5a8-7b1c-7e2d-8f3a-0000000000dd',
  releaseId: '0190f5a8-7b1c-7e2d-8f3a-0000000000ee',
  replica: 0,
  container: 'sk-shop-web-0123456789ab-r1-0',
  cpuMillis: 250,
  memoryBytes: 256 * 2 ** 20,
  placedAt: '2026-11-21T09:00:00Z',
  application: { id: '0190f5a8-7b1c-7e2d-8f3a-0000000000a1', name: 'shop-web' },
  project: { id: '0190f5a8-7b1c-7e2d-8f3a-0000000000p1', name: 'Shop' },
  environment: { id: '0190f5a8-7b1c-7e2d-8f3a-0000000000e1', name: 'production' },
  state: 'running',
  stopReason: null,
  observedAt: '2026-11-22T09:59:30Z',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('server page (#264)', () => {
  let harness: RouterTestingHarness;
  let routes: Partial<Record<string, () => Response>>;

  beforeEach(async () => {
    routes = {
      [`GET ${BASE}/nodes`]: () => json({ items: [node], nextCursor: null }),
      [`GET ${BASE}/nodes/${NODE}`]: () => json(node),
      [`GET ${BASE}/nodes/${NODE}/replicas`]: () => json({ items: [replica], truncated: false }),
      [`GET ${BASE}/nodes/${NODE}/metrics`]: () => json({ kept: false }),
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
            const handler = routes[`${request.method} ${new URL(request.url).pathname}`];
            return Promise.resolve(handler ? handler() : json({}, 404));
          },
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
  async function open(url: string): Promise<void> {
    await harness.navigateByUrl(url);
    for (let i = 0; i < 6; i++) {
      await harness.fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    harness.fixture.detectChanges();
  }

  it('shows the server, its machine and what runs on it', async () => {
    await open(`/orgs/${ORG}/servers/${NODE}`);
    const text = element().textContent;
    expect(element().querySelector('h1')?.textContent).toContain('edge-1');
    expect(text).toContain('ready');
    expect(text).toContain('agent 0.1.0-alpha.3');
    expect(text).toContain('edge-1.example.com · Ubuntu 24.04');
    expect(text).toContain('8 GiB');
    expect(text).toContain('region=par');
    expect(text).toContain('None declared');
    // Not built yet: said, never pretended.
    expect(text).toContain('Terminal');
    expect(text).not.toContain('Preview · sample data');

    await open(`/orgs/${ORG}/servers/${NODE}?section=resources`);
    const row = [...element().querySelectorAll('a')].find((a) => a.textContent === 'shop-web');
    expect(row?.getAttribute('href')).toBe(
      `/orgs/${ORG}/projects/${replica.project.id}/environments/${replica.environment.id}/applications/${replica.application.id}`,
    );
    const table = element().textContent;
    expect(table).toContain('Shop · production');
    expect(table).toContain('0.25');
    expect(table).toContain('256 MiB');
    expect(table).toContain('running');
    expect(table).not.toContain('Only the first 200 replicas are listed.');
  });

  it('speaks French, names stay as typed', async () => {
    TestBed.inject(I18n).use('fr');
    routes[`GET ${BASE}/nodes/${NODE}/replicas`] = () => json({ items: [], truncated: true });
    await open(`/orgs/${ORG}/servers/${NODE}?section=agent`);
    const text = element().textContent;
    expect(text).toContain('edge-1');
    expect(text).toContain('Époque');
    expect(text).toMatch(/il y a \d+ s/);
    await open(`/orgs/${ORG}/servers/${NODE}?section=resources`);
    expect(element().textContent).toContain('Aucune réplique ne tourne sur ce serveur.');
    expect(element().textContent).toContain('Seules les 200 premières répliques sont listées.');
    // A quarter of a core, with the French decimal comma.
    routes[`GET ${BASE}/nodes/${NODE}/replicas`] = () =>
      json({ items: [replica], truncated: false });
    await open(`/orgs/${ORG}/servers`);
    await open(`/orgs/${ORG}/servers/${NODE}?section=resources`);
    expect(element().textContent).toContain('0,25');
    expect(element().textContent).not.toContain('0.25');
  });

  it('says when the server is not there', async () => {
    routes[`GET ${BASE}/nodes/${NODE}`] = () => json({ status: 404 }, 404);
    await open(`/orgs/${ORG}/servers/${NODE}`);
    expect(element().querySelector('h1')?.textContent).toContain('Server not found');
    expect(element().textContent).not.toContain('edge-1');
  });

  it('opens from the server list', async () => {
    await open(`/orgs/${ORG}/servers`);
    const link = [...element().querySelectorAll('a')].find((a) => a.textContent === 'edge-1');
    expect(link?.getAttribute('href')).toBe(`/orgs/${ORG}/servers/${NODE}`);
  });
});
