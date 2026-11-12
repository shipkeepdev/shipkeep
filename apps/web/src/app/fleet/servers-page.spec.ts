import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { InstallCommand, installCommand } from './install-command';

import { appRoutes } from '../app.routes';
import { IDENTITY_FETCH } from '../identity/identity-api';
import { PRIVATE_CLIPBOARD } from '../identity/private-clipboard';

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
  publicAddresses: [] as string[],
  leaseEpoch: 1,
  createdAt: '2026-11-06T09:00:00Z',
  lastHeartbeatAt: '2026-11-06T09:00:00Z',
};
const other = { ...node, id: '0190f5a8-7b1c-7e2d-8f3a-0000000000cc', name: 'edge-2' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('servers page', () => {
  let harness: RouterTestingHarness;
  let requests: { method: string; path: string; body: unknown }[];
  let nodes: unknown[];
  /** While set, address saves wait for it, as a slow network would. */
  let held: Promise<void> | undefined;

  beforeEach(async () => {
    requests = [];
    nodes = [node, other];
    held = undefined;
    const routes: Partial<Record<string, () => Response | Promise<Response>>> = {
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
      [`POST ${BASE}/nodes/${NODE}/public-addresses`]: async () => {
        const sent = (requests.at(-1)?.body as { publicAddresses: string[] }).publicAddresses;
        await held;
        if (sent.includes('10.0.0.5'))
          return json(
            {
              status: 400,
              code: 'node_public_address_not_public',
              details: { index: sent.indexOf('10.0.0.5') },
            },
            400,
          );
        nodes = [{ ...node, publicAddresses: sent }];
        return json(nodes[0]);
      },
      [`POST ${BASE}/nodes/${NODE}/remove`]: () => {
        nodes = [];
        return new Response(null, { status: 204 });
      },
    };
    copied = [];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PRIVATE_CLIPBOARD,
          useValue: (value: string) => {
            copied.push(value);
            return Promise.resolve();
          },
        },
        provideRouter(
          appRoutes,
          withComponentInputBinding(),
          withRouterConfig({ paramsInheritanceStrategy: 'always' }),
        ),
        {
          provide: InstallCommand,
          useValue: {
            load: () =>
              Promise.resolve((token: { gatewayAddress: string; caFingerprint: string }) =>
                installCommand(
                  'https://shipkeep.example.com',
                  { installer: 'b'.repeat(64), amd64: 'c'.repeat(64), arm64: 'd'.repeat(64) },
                  token,
                ),
              ),
          },
        },
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

  let copied: string[] = [];
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

  it('issues a join token after re-authentication and shows a verified install command', async () => {
    fill('join-password', 'correct horse browser fixture');
    await submit('#join-password');
    expect(requests.find((r) => r.method === 'POST')).toEqual({
      method: 'POST',
      path: `${BASE}/join-tokens`,
      body: { password: 'correct horse browser fixture' },
    });
    expect(element().querySelector<HTMLInputElement>('#join-token')?.value).toBe(TOKEN);
    const config = element().querySelector('pre[aria-label="Install command"]')?.textContent ?? '';
    expect(config).toContain("--control-plane 'shipkeep.example.com:7443'");
    expect(config).toContain(`--ca-fingerprint '${FINGERPRINT}'`);
    // The token stays out of the configuration and of command lines.
    expect(config).not.toContain(TOKEN);
    expect(element().textContent).not.toContain('correct horse');
    // The command is long and scrolls sideways: one button copies all of it, and only it.
    const copy = [...element().querySelectorAll('button')].find(
      (button) => button.textContent.trim() === 'Copy the command',
    );
    copy?.click();
    await settle();
    expect(copied).toEqual([config]);
    // The confirmation names the command and sits next to its button, not under the token.
    const statuses = [...element().querySelectorAll('[role="status"]')].map((status) =>
      status.textContent.trim(),
    );
    expect(statuses).toEqual(['Command copied.']);
  });

  it('keeps the issued token when the command cannot carry the gateway address', async () => {
    // The manifest loads, but building the command throws: the token already exists and is shown
    // once, so the page must fall back to the manual setup instead of failing the whole request.
    vi.spyOn(TestBed.inject(InstallCommand), 'load').mockResolvedValue(() => {
      throw new Error('Verified installer requires HTTPS and valid build artifacts.');
    });
    fill('join-password', 'correct horse browser fixture');
    await submit('#join-password');
    expect(element().querySelector<HTMLInputElement>('#join-token')?.value).toBe(TOKEN);
    expect(element().querySelector('pre[aria-label="Install command"]')).toBeNull();
    expect(element().querySelector('pre[aria-label="agent.yaml"]')?.textContent).toContain(
      'address: shipkeep.example.com:7443',
    );
    // The request is not reported as failed. The only alert left is the shell's, about the
    // organization this fixture does not stub.
    const alerts = [...element().querySelectorAll('[role="alert"]')].map((alert) =>
      alert.textContent.trim(),
    );
    expect(alerts.filter((text) => !text.startsWith('This organization is not available'))).toEqual(
      [],
    );
  });

  it('falls back to the manual setup when the installer is unavailable, without the token', async () => {
    vi.spyOn(TestBed.inject(InstallCommand), 'load').mockRejectedValue(new Error('no manifest'));
    fill('join-password', 'correct horse browser fixture');
    await submit('#join-password');
    expect(element().querySelector<HTMLInputElement>('#join-token')?.value).toBe(TOKEN);
    expect(element().querySelector('pre[aria-label="Install command"]')).toBeNull();
    const config = element().querySelector('pre[aria-label="agent.yaml"]')?.textContent ?? '';
    expect(config).toContain('address: shipkeep.example.com:7443');
    expect(config).toContain(`ca_fingerprint: ${FINGERPRINT}`);
    expect(config).not.toContain(TOKEN);
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

  it('edits the public addresses of a server, with field messages for refused values', async () => {
    const table = () =>
      element().querySelector('[role="region"][aria-label="Servers"]')?.textContent ?? '';
    expect(table()).toContain('not set');
    element()
      .querySelector<HTMLButtonElement>('button[aria-label="Edit the public addresses of edge-1"]')
      ?.click();
    await settle();
    const field = () => element().querySelector<HTMLTextAreaElement>('#public-addresses');
    const error = () => element().querySelector('#addresses-error')?.textContent.trim() ?? '';
    expect(document.activeElement).toBe(field());
    expect(field()?.getAttribute('aria-describedby')).toContain('addresses-error');

    // A typo is caught before anything is sent.
    fill('public-addresses', '8.8.8.8\nedge-1.example.com');
    await submit('#public-addresses');
    expect(error()).toBe('Address 2 is not an IP address.');
    expect(field()?.getAttribute('aria-invalid')).toBe('true');
    expect(requests.filter((r) => r.method === 'POST')).toEqual([]);

    // The API decides what is public, and the message names the position it refused.
    fill('public-addresses', '8.8.8.8\n10.0.0.5');
    await submit('#public-addresses');
    expect(error()).toBe('Address 2 is private or reserved. Enter the address visitors reach.');

    fill('public-addresses', ' 8.8.8.8\n\n2606:4700:4700::1111 ');
    expect(error()).toBe('');
    await submit('#public-addresses');
    expect(requests.filter((r) => r.method === 'POST').map((r) => r.body)).toEqual([
      { publicAddresses: ['8.8.8.8', '10.0.0.5'] },
      { publicAddresses: ['8.8.8.8', '2606:4700:4700::1111'] },
    ]);
    expect(field()).toBeNull();
    expect(table()).toContain('8.8.8.8');
    expect(table()).toContain('+1 more');
  });

  it('holds row actions while a save is pending, then edits another server cleanly', async () => {
    const open = (name: string) => {
      element()
        .querySelector<HTMLButtonElement>(
          `button[aria-label="Edit the public addresses of ${name}"]`,
        )
        ?.click();
      harness.fixture.detectChanges();
    };
    let release: (() => void) | undefined;
    held = new Promise((resolve) => {
      release = resolve;
    });
    open('edge-1');
    fill('public-addresses', '10.0.0.5');
    element()
      .querySelector('#public-addresses')
      ?.closest('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.fixture.detectChanges();
    expect(requests.filter((r) => r.method === 'POST').map((r) => r.body)).toEqual([
      { publicAddresses: ['10.0.0.5'] },
    ]);
    // Row actions wait for the save: neither another server nor a removal can start meanwhile.
    const button = (label: string) =>
      element().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button('Edit the public addresses of edge-2')?.disabled).toBe(true);
    expect(button('Remove edge-1')?.disabled).toBe(true);
    release?.();
    await settle();
    expect(element().querySelector('#addresses-error')?.textContent.trim()).toBe(
      'Address 1 is private or reserved. Enter the address visitors reach.',
    );
    open('edge-2');
    await settle();
    expect(element().querySelector('#addresses-title')?.textContent).toContain('edge-2');
    expect(element().querySelector('#addresses-error')?.textContent.trim()).toBe('');
    expect(element().querySelector('#public-addresses')?.getAttribute('aria-invalid')).toBeNull();
  });
});

describe('installer command boundary', () => {
  const pins = { installer: 'b'.repeat(64), amd64: 'c'.repeat(64), arm64: 'd'.repeat(64) };
  const token = { gatewayAddress: 'shipkeep.example.com:7443', caFingerprint: FINGERPRINT };
  it.each(["host'; touch /tmp/pwned; '", '$(id)', 'host:7443\n', 'host:7443 `id`'])(
    'rejects shell input %s',
    (gatewayAddress) => {
      expect(() =>
        installCommand('https://shipkeep.example.com', pins, { ...token, gatewayAddress }),
      ).toThrow();
    },
  );
  it('rejects HTTP and malformed digests; never includes the join token', () => {
    expect(() => installCommand('http://shipkeep.example.com', pins, token)).toThrow();
    expect(() =>
      installCommand(
        'https://shipkeep.example.com',
        { ...pins, installer: `${pins.installer}\n` },
        token,
      ),
    ).toThrow();
    const command = installCommand('https://shipkeep.example.com', pins, {
      ...token,
      token: TOKEN,
    } as typeof token);
    // A mismatch says so and runs nothing; the cleanup keeps the status of the step that failed.
    expect(command).toContain(
      "sha256sum --check --status || { echo 'shipkeep: installer checksum mismatch, nothing was run' >&2; false; }; } &&",
    );
    expect(command.trimEnd().endsWith('(exit "$shipkeep_install_status"); }')).toBe(true);
    expect(command.indexOf('rm -rf')).toBeGreaterThan(command.indexOf('sudo bash'));
    expect(command).not.toContain(TOKEN);
  });
});
