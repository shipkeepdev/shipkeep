import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { appRoutes } from '../app.routes';
import { IDENTITY_FETCH } from '../identity/identity-api';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const GHCR = '0190f5a8-7b1c-7e2d-8f3a-0000000000e1';
const HUB = '0190f5a8-7b1c-7e2d-8f3a-0000000000e2';
const ORG_PATH = `/api/v1/organizations/${ORG}`;
/** Obviously fake: no real token has this shape. */
const PASSWORD = 'sk_test_fake_registry_password_screen';
const stamp = { createdAt: '2026-11-05T12:00:00Z', updatedAt: '2026-11-07T09:30:00Z' };
const ghcr = {
  id: GHCR,
  server: 'ghcr.io',
  username: 'deploy-bot',
  version: 2,
  updatedBy: null,
  ...stamp,
};
const hub = {
  id: HUB,
  server: 'docker.io',
  username: 'acme',
  version: 1,
  updatedBy: null,
  ...stamp,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (status: number, code: string) => json({ status, code, title: 'Refused' }, status);

/** ADR 0019: the Registries section of the Organization page. */
describe('registry credentials of an organization', () => {
  let harness: RouterTestingHarness;
  let posts: { path: string; body: unknown }[];
  /** What the server holds, and what it answers to the next changes. */
  let stored: (typeof ghcr)[];
  let answers: Response[];
  let listStatus: number;

  beforeEach(async () => {
    posts = [];
    stored = [hub, ghcr];
    answers = [];
    listStatus = 200;
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
            if (request.method === 'GET') {
              if (path === `${ORG_PATH}/registries`)
                return listStatus === 200
                  ? json({ items: stored })
                  : problem(listStatus, 'not_found');
              if (path === ORG_PATH) return json({ id: ORG, name: 'Acme', slug: 'acme', ...stamp });
              return json({ items: [], nextCursor: null });
            }
            const text = await request.clone().text();
            posts.push({ path, body: text ? (JSON.parse(text) as unknown) : undefined });
            return answers.shift() ?? new Response(null, { status: 204 });
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
  async function open(): Promise<void> {
    await harness.navigateByUrl(`/orgs/${ORG}/organization?section=registries`);
    await settle();
  }
  const text = () => element().textContent.replace(/\s+/g, ' ');
  const button = (label: string) => {
    const found = [...element().querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) =>
        candidate.textContent.trim() === label || candidate.getAttribute('aria-label') === label,
    );
    if (!found) throw new Error(`missing button ${label}`);
    return found;
  };
  async function click(label: string): Promise<void> {
    button(label).click();
    await settle();
  }
  const field = (id: string) => {
    const input = element().querySelector<HTMLInputElement>(`#registry-${id}`);
    if (!input) throw new Error(`missing field ${id}`);
    return input;
  };
  function fill(id: string, value: string): void {
    const input = field(id);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }
  async function submit(): Promise<void> {
    harness.fixture.detectChanges();
    element()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  }

  it('lists each registry with its account and version, and nothing about its password', async () => {
    await open();
    const rows = [...element().querySelectorAll('[role="group"]')].map((row) =>
      row.textContent.replace(/\s+/g, ' ').trim(),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('docker.io');
    expect(rows[0]).toContain('acme');
    for (const part of ['ghcr.io', 'deploy-bot', 'version 2']) expect(rows[1]).toContain(part);
    // The design showed a state per registry; nothing checks one, so none is claimed.
    expect(text()).not.toMatch(/\bok\b/);
    expect(element().querySelector('input[type="password"]')).toBeNull();
  });

  it('adds a registry, then forgets the password it was given', async () => {
    await open();
    await click('Add a registry');
    expect(button('Save the credentials').disabled).toBe(true);
    fill('server', 'registry.example.com:5000');
    fill('username', 'deploy-bot');
    fill('password', PASSWORD);
    stored = [...stored, { ...ghcr, id: 'new', server: 'registry.example.com:5000', version: 1 }];
    answers = [json(stored[2])];
    await submit();

    expect(posts).toEqual([
      {
        path: `${ORG_PATH}/registries`,
        body: { server: 'registry.example.com:5000', username: 'deploy-bot', password: PASSWORD },
      },
    ]);
    // The form closes, the list is read again, and the password is nowhere on the page.
    expect(element().querySelector('form')).toBeNull();
    expect(text()).toContain('registry.example.com:5000');
    expect(element().innerHTML).not.toContain(PASSWORD);
  });

  it('replaces the credentials of a registry without letting its host change', async () => {
    await open();
    await click('Replace the credentials of ghcr.io');
    expect(field('server').value).toBe('ghcr.io');
    expect(field('server').readOnly).toBe(true);
    expect(field('username').value).toBe('deploy-bot');
    expect(field('password').value).toBe('');
    fill('username', 'release-bot');
    fill('password', PASSWORD);
    answers = [json({ ...ghcr, username: 'release-bot', version: 3 })];
    await submit();
    expect(posts).toEqual([
      {
        path: `${ORG_PATH}/registries`,
        body: { server: 'ghcr.io', username: 'release-bot', password: PASSWORD },
      },
    ]);
  });

  it('asks once more before it removes credentials', async () => {
    await open();
    await click('Remove the credentials of ghcr.io');
    expect(posts).toEqual([]);
    expect(text()).toContain('The next deployment that must pull a private image');
    await click('Keep them');
    expect(posts).toEqual([]);

    await click('Remove the credentials of ghcr.io');
    stored = [hub];
    await click('Remove them');
    expect(posts).toEqual([{ path: `${ORG_PATH}/registries/${GHCR}/remove`, body: undefined }]);
    expect(element().querySelectorAll('[role="group"]')).toHaveLength(1);
    expect(text()).not.toContain('The next deployment that must pull');
  });

  it('says why a host is refused, keeps the form, and sends the corrected one', async () => {
    await open();
    await click('Add a registry');
    fill('server', 'registry.example.com');
    fill('username', 'deploy-bot');
    fill('password', PASSWORD);
    answers = [problem(400, 'invalid_registry_server')];
    await submit();
    expect(element().querySelector('[role="alert"]')?.textContent).toContain(
      'This is not a registry host.',
    );
    // The password is asked again: it is not kept after a refusal.
    expect(field('password').value).toBe('');
    expect(field('server').value).toBe('registry.example.com');

    fill('server', 'registry.example.org');
    fill('password', PASSWORD);
    answers = [json({ ...ghcr, id: 'new', server: 'registry.example.org', version: 1 })];
    await submit();
    expect(posts).toHaveLength(2);
    expect(element().querySelector('[role="alert"]')).toBeNull();
  });

  it('explains the limit, and still works after it', async () => {
    await open();
    await click('Add a registry');
    fill('server', 'one-too-many.example.com');
    fill('username', 'deploy-bot');
    fill('password', PASSWORD);
    answers = [problem(409, 'registry_limit_reached')];
    await submit();
    expect(element().querySelector('[role="alert"]')?.textContent).toContain(
      'already stores credentials for 100 registries',
    );
    // A conflict must not leave the screen dead: removing one is the way out.
    await click('Remove the credentials of ghcr.io');
    stored = [hub];
    await click('Remove them');
    expect(posts.map((post) => post.path)).toEqual([
      `${ORG_PATH}/registries`,
      `${ORG_PATH}/registries/${GHCR}/remove`,
    ]);
    expect(element().querySelector('[role="alert"]')).toBeNull();
  });

  it('shows the list again when the credentials changed while they were being removed', async () => {
    await open();
    await click('Remove the credentials of ghcr.io');
    answers = [problem(409, 'registry_credentials_changed')];
    stored = [hub, { ...ghcr, username: 'release-bot', version: 3 }];
    await click('Remove them');
    expect(element().querySelector('[role="alert"]')?.textContent).toContain(
      'These credentials changed in the meantime.',
    );
    expect(text()).toContain('release-bot');
    // The same removal can be asked again.
    stored = [hub];
    await click('Remove them');
    expect(posts).toHaveLength(2);
    expect(element().querySelectorAll('[role="group"]')).toHaveLength(1);
  });

  it('does not offer the form to a host it can tell is wrong, nor to a user name with a colon', async () => {
    await open();
    await click('Add a registry');
    fill('username', 'deploy-bot');
    fill('password', PASSWORD);
    for (const server of ['https://ghcr.io', 'ghcr.io/acme', 'user:pw@ghcr.io', 'ghcr .io', '']) {
      fill('server', server);
      harness.fixture.detectChanges();
      expect(button('Save the credentials').disabled, server).toBe(true);
    }
    fill('server', 'ghcr.io');
    fill('username', 'deploy:bot');
    harness.fixture.detectChanges();
    expect(button('Save the credentials').disabled).toBe(true);
    fill('username', 'deploy-bot');
    harness.fixture.detectChanges();
    expect(button('Save the credentials').disabled).toBe(false);
  });

  it('empties the form when it is cancelled', async () => {
    await open();
    await click('Add a registry');
    fill('server', 'ghcr.io');
    fill('password', PASSWORD);
    await click('Cancel');
    expect(element().querySelector('form')).toBeNull();
    await click('Add a registry');
    expect(field('server').value).toBe('');
    expect(field('password').value).toBe('');
  });

  it('tells a member that administrators manage registries, and offers nothing', async () => {
    listStatus = 404;
    await open();
    const section = element().querySelector('sk-registry-credentials');
    expect(section?.textContent).toContain('Only owners and administrators of the organization');
    expect(section?.querySelectorAll('button, form, [role="alert"]')).toHaveLength(0);
  });

  it('says so when there is none yet', async () => {
    stored = [];
    await open();
    expect(text()).toContain('No registry yet. Public images need none.');
    expect(button('Add a registry').disabled).toBe(false);
  });
});
