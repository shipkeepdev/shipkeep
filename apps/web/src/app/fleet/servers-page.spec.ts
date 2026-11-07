import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { appRoutes } from '../app.routes';
import { IDENTITY_FETCH } from '../identity/identity-api';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const NODE = '0190f5a8-7b1c-7e2d-8f3a-0000000000bb';
const BASE = `/api/v1/organizations/${ORG}`;
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const TOKEN = 'J'.repeat(43);
const node = {
  id: NODE,
  name: 'edge-1',
  status: 'ready',
  labels: {},
  facts: { cpu_count: 4, memory_bytes: 8 * 2 ** 30 },
  leaseEpoch: 1,
  createdAt: '2026-11-06T09:00:00Z',
  lastHeartbeatAt: '2026-11-06T09:00:00Z',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('servers page', () => {
  let harness: RouterTestingHarness;
  let requests: { method: string; path: string; body: unknown }[];
  let nodes: unknown[];

  beforeEach(async () => {
    requests = [];
    nodes = [node];
    const routes: Partial<Record<string, () => Response>> = {
      [`GET ${BASE}/nodes`]: () => json({ items: nodes, nextCursor: null }),
      [`POST ${BASE}/join-tokens`]: () =>
        json(
          {
            id: 't1',
            token: TOKEN,
            expiresAt: '2026-11-06T09:15:00Z',
            caFingerprint: FINGERPRINT,
            gatewayAddress: 'shipkeep.example.com:7443',
          },
          201,
        ),
      [`POST ${BASE}/confirmations`]: () =>
        json({ id: 'c1', token: 'confirmation-fixture', expiresAt: '2026-11-06T09:05:00Z' }, 201),
      [`POST ${BASE}/nodes/${NODE}/remove`]: () => {
        nodes = [];
        return new Response(null, { status: 204 });
      },
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
    await harness.navigateByUrl(`/orgs/${ORG}/servers`);
    await settle();
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
    const input = element().querySelector<HTMLInputElement>(`#${id}`);
    if (!input) throw new Error(`missing ${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    harness.fixture.detectChanges();
  }
  async function submit(selector: string): Promise<void> {
    element()
      .querySelector(selector)
      ?.closest('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  }

  it('lists servers with their status and capacity', () => {
    const table =
      element().querySelector('[role="region"][aria-label="Servers"]')?.textContent ?? '';
    expect(table).toContain('edge-1');
    expect(table).toContain('ready');
    expect(table).toContain('4 CPU · 8 GiB');
  });

  it('issues a join token after re-authentication and shows the agent configuration', async () => {
    fill('join-password', 'correct horse browser fixture');
    await submit('#join-password');
    expect(requests.find((r) => r.method === 'POST')).toEqual({
      method: 'POST',
      path: `${BASE}/join-tokens`,
      body: { password: 'correct horse browser fixture' },
    });
    expect(element().querySelector<HTMLInputElement>('#join-token')?.value).toBe(TOKEN);
    const config = element().querySelector('pre[aria-label="agent.yaml"]')?.textContent ?? '';
    expect(config).toContain('address: shipkeep.example.com:7443');
    expect(config).toContain(`ca_fingerprint: ${FINGERPRINT}`);
    // The token stays out of the configuration and of command lines.
    expect(config).not.toContain(TOKEN);
    expect(element().textContent).not.toContain('correct horse');
  });

  it('removes a server only after its exact name is typed, with a confirmation token', async () => {
    element().querySelector<HTMLButtonElement>('button[aria-label="Remove edge-1"]')?.click();
    await settle();
    const confirm = () =>
      Array.from(element().querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        b.textContent.includes('Remove the server'),
      );
    fill('confirm-name', 'edge');
    expect(confirm()?.disabled).toBe(true);
    fill('confirm-name', 'edge-1');
    expect(confirm()?.disabled).toBe(false);
    await submit('#confirm-name');
    expect(requests.filter((r) => r.method === 'POST')).toEqual([
      {
        method: 'POST',
        path: `${BASE}/confirmations`,
        body: { action: 'node.remove', target: NODE, name: 'edge-1' },
      },
      {
        method: 'POST',
        path: `${BASE}/nodes/${NODE}/remove`,
        body: { confirmation: 'confirmation-fixture' },
      },
    ]);
    expect(element().textContent).toContain('No server yet.');
  });
});
