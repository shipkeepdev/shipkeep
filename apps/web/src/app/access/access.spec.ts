import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { appRoutes } from '../app.routes';
import { IDENTITY_FETCH } from '../identity/identity-api';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const PROJECT = '0190f5a8-7b1c-7e2d-8f3a-0000000000bb';
const ENV = '0190f5a8-7b1c-7e2d-8f3a-0000000000cc';
const M1 = '0190f5a8-7b1c-7e2d-8f3a-0000000000d1';
const M2 = '0190f5a8-7b1c-7e2d-8f3a-0000000000d2';
const CURSOR = '0190f5a8-7b1c-7e2d-8f3a-0000000000e1';
const PASSWORD = 'correct horse battery staple';
const ORG_PATH = `/api/v1/organizations/${ORG}`;
const PROJECT_PATH = `${ORG_PATH}/projects/${PROJECT}`;
const ENV_PATH = `${PROJECT_PATH}/environments/${ENV}`;
const stamp = { createdAt: '2026-11-07T12:00:00Z', updatedAt: '2026-11-07T12:00:00Z' };
const member = (id: string, email: string, orgRole = 'member') => ({
  id,
  organizationId: ORG,
  userId: id,
  orgRole,
  email,
  active: true,
  ...stamp,
});
const binding = (
  id: string,
  email: string,
  role: string,
  source: string,
  directRole: string | null,
  inheritedRole: string | null,
) => ({ ...member(id, email), role, source, directRole, inheritedRole });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const page = (items: unknown[], nextCursor: string | null = null) => json({ items, nextCursor });
type Answer = (url: URL) => Response;

describe('access screens', () => {
  let harness: RouterTestingHarness;
  let posts: { path: string; body: Record<string, unknown>; key: string | null }[];
  let routes: Partial<Record<string, Answer>>;

  beforeEach(async () => {
    posts = [];
    routes = {
      [`GET ${ORG_PATH}/members`]: () =>
        page([member(M1, 'owner@example.com', 'owner'), member(M2, 'dev@example.com')]),
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
            const url = new URL(request.url);
            if (request.method === 'POST')
              posts.push({
                path: url.pathname,
                body: JSON.parse(await request.clone().text()) as Record<string, unknown>,
                key: request.headers.get('idempotency-key'),
              });
            const answer = routes[`${request.method} ${url.pathname}`];
            return answer ? answer(url) : json({}, 404);
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
  function control(id: string): HTMLInputElement {
    const found = element().querySelector<HTMLInputElement>(`#${id}`);
    if (!found) throw new Error(`missing ${id}`);
    return found;
  }
  function fill(id: string, value: string): void {
    const input = control(id);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    harness.fixture.detectChanges();
  }
  function choose(id: string, value: string): void {
    const select = control(id);
    select.value = value;
    select.dispatchEvent(new Event('change'));
    harness.fixture.detectChanges();
  }
  function submitButton(label: string): HTMLButtonElement {
    const found = [...element().querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find(
      (button) => button.textContent.includes(label),
    );
    if (!found) throw new Error(`missing ${label}`);
    return found;
  }
  function row(text: string): HTMLElement {
    const found = [...element().querySelectorAll<HTMLElement>('li, [role="listitem"]')].find(
      (item) => item.textContent.includes(text),
    );
    if (!found) throw new Error(`missing ${text}`);
    return found;
  }
  async function click(scope: HTMLElement, label: string): Promise<void> {
    const found = [...scope.querySelectorAll('button')].find((button) =>
      button.textContent.includes(label),
    );
    if (!found) throw new Error(`missing ${label}`);
    found.click();
    await settle();
  }
  async function submit(label: string): Promise<void> {
    submitButton(label)
      .closest('form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
  }
  async function members(): Promise<void> {
    await harness.navigateByUrl(`/orgs/${ORG}/members`);
    await settle();
    // Adding someone starts from the Invite button, as in the design.
    await click(element(), 'Invite');
  }

  it('adds a member with a fresh password and forgets it afterwards', async () => {
    routes[`POST ${ORG_PATH}/members`] = () => json({ membership: member(M2, 'x') }, 201);
    await members();
    expect(row('owner@example.com').textContent).toContain('owner');
    expect(submitButton('Add member').disabled).toBe(true);
    fill('member-add-email', 'new@example.com');
    choose('member-add-role', 'admin');
    fill('member-add-password', PASSWORD);
    await submit('Add member');
    expect(posts).toEqual([
      {
        path: `${ORG_PATH}/members`,
        body: { email: 'new@example.com', role: 'admin', password: PASSWORD },
        key: expect.any(String) as string,
      },
    ]);
    expect(control('member-add-password').value).toBe('');
    expect(control('member-add-email').value).toBe('');
    expect(element().querySelector('[role="status"]')?.textContent).toContain('Member added.');
  });

  it('sends an authenticator code and a recovery code in their own fields', async () => {
    routes[`POST ${ORG_PATH}/members`] = () => json({ membership: member(M2, 'x') }, 201);
    await members();
    fill('member-add-email', 'a@example.com');
    fill('member-add-password', PASSWORD);
    fill('member-add-code', '123456');
    await submit('Add member');
    expect(posts.at(-1)?.body).toMatchObject({ totp: '123456' });
    expect(posts.at(-1)?.body).not.toHaveProperty('recovery');
    fill('member-add-email', 'b@example.com');
    fill('member-add-password', PASSWORD);
    fill('member-add-code', 'a'.repeat(32));
    await submit('Add member');
    expect(posts.at(-1)?.body).toMatchObject({ recovery: 'a'.repeat(32) });
    expect(posts.at(-1)?.body).not.toHaveProperty('totp');
  });

  it('refuses malformed input before sending anything', async () => {
    await members();
    fill('member-add-email', 'a@example.com');
    fill('member-add-password', PASSWORD);
    expect(submitButton('Add member').disabled).toBe(false);
    for (const code of ['12345', 'abcdef', '1234567', "1' OR '1", 'A'.repeat(32)]) {
      fill('member-add-code', code);
      expect(submitButton('Add member').disabled).toBe(true);
    }
    fill('member-add-code', '');
    fill('member-add-password', 'too short');
    expect(submitButton('Add member').disabled).toBe(true);
    fill('member-add-password', PASSWORD);
    for (const email of ['', 'not-an-email', '<script>@', 'a@b c.com']) {
      fill('member-add-email', email);
      expect(submitButton('Add member').disabled).toBe(true);
    }
    await submit('Add member');
    expect(posts).toEqual([]);
  });

  it('changes a role from the member row, starting from the current role', async () => {
    routes[`POST ${ORG_PATH}/members/${M2}/role`] = () => json({ membership: member(M2, 'x') });
    await members();
    await click(row('dev@example.com'), 'Change role');
    expect(control('member-role-role').value).toBe('member');
    choose('member-role-role', 'admin');
    fill('member-role-password', PASSWORD);
    await submit('Change role');
    expect(posts.at(-1)).toMatchObject({
      path: `${ORG_PATH}/members/${M2}/role`,
      body: { role: 'admin', password: PASSWORD },
    });
    expect(element().querySelector('#member-role-role')).toBeNull();
  });

  it('keeps the removal open after a refusal and retries once edited', async () => {
    let answer = () => json({}, 409);
    routes[`POST ${ORG_PATH}/members/${M1}/remove`] = () => answer();
    await members();
    await click(row('owner@example.com'), 'Remove');
    fill('member-remove-password', PASSWORD);
    fill('member-remove-code', '123456');
    await submit('Remove member');
    expect(element().querySelector('[role="alert"]')).not.toBeNull();
    // The code was spent, the password stays so a new code is enough.
    expect(control('member-remove-code').value).toBe('');
    expect(control('member-remove-password').value).toBe(PASSWORD);

    answer = () => json({ membership: null });
    fill('member-remove-code', '654321');
    await submit('Remove member');
    expect(posts).toHaveLength(2);
    expect(posts[0]?.key).not.toBe(posts[1]?.key);
    expect(element().querySelector('#member-remove-password')).toBeNull();
    expect(element().querySelector('[role="status"]')?.textContent).toContain('Member removed.');
  });

  it('cancels without sending anything', async () => {
    await members();
    await click(row('dev@example.com'), 'Remove');
    fill('member-remove-password', PASSWORD);
    await click(row('dev@example.com'), 'Cancel');
    expect(element().querySelector('#member-remove-password')).toBeNull();
    expect(posts).toEqual([]);
    await click(row('dev@example.com'), 'Remove');
    expect(control('member-remove-password').value).toBe('');
  });

  it('pages through members and says when the list is refused', async () => {
    routes[`GET ${ORG_PATH}/members`] = (url) =>
      url.searchParams.get('cursor') === CURSOR
        ? page([member(M2, 'dev@example.com')])
        : page([member(M1, 'owner@example.com', 'owner')], CURSOR);
    await members();
    await click(element(), 'Show more members');
    expect(row('dev@example.com')).toBeDefined();
    expect(element().textContent).not.toContain('Show more members');

    routes[`GET ${ORG_PATH}/members`] = () => json({}, 404);
    await harness.navigateByUrl(`/orgs/${ORG}`);
    await harness.navigateByUrl(`/orgs/${ORG}/members`);
    await settle();
    expect(element().querySelector('[role="alert"]')).not.toBeNull();
  });

  describe('roles on a project and an environment', () => {
    beforeEach(() => {
      const project = { id: PROJECT, organizationId: ORG, name: 'Billing', slug: 'billing' };
      routes[`GET ${PROJECT_PATH}`] = () => json({ ...project, gitWriteMode: 'commit', ...stamp });
      routes[`GET ${PROJECT_PATH}/environments`] = () => page([]);
      routes[`GET ${PROJECT_PATH}/api-tokens`] = () => json({}, 404);
      routes[`GET ${PROJECT_PATH}/bindings`] = () =>
        page([
          binding(M1, 'owner@example.com', 'admin', 'organization', null, 'admin'),
          binding(M2, 'dev@example.com', 'developer', 'project', 'developer', null),
        ]);
    });

    it('hides the access and token panels from people who cannot manage them', async () => {
      routes[`GET ${PROJECT_PATH}/bindings`] = () => json({}, 404);
      await harness.navigateByUrl(`/orgs/${ORG}/projects/${PROJECT}`);
      await settle();
      expect(element().textContent).not.toContain('Give someone a role');
      expect(element().textContent).not.toContain('API tokens of this project');
      expect(element().querySelector('#binding-add-password')).toBeNull();
      expect(element().querySelector('[role="alert"]')).toBeNull();
    });

    it('lists project tokens and revokes an active one', async () => {
      const token = (id: string, name: string, status: string) => ({
        id,
        name,
        status,
        scopes: [{ permission: 'deploy.run', organizationId: ORG, projectId: PROJECT }],
        project: { organizationId: ORG, projectId: PROJECT },
        createdAt: stamp.createdAt,
        expiresAt: '2026-12-07T12:00:00Z',
        revokedAt: null,
        lastUsedAt: null,
        createdBy: M2,
      });
      routes[`GET ${PROJECT_PATH}/api-tokens`] = () =>
        page([token(M1, 'ci-deploy', 'active'), token(M2, 'old-token', 'revoked')]);
      routes[`POST ${PROJECT_PATH}/api-tokens/${M1}/revoke`] = () =>
        new Response(null, { status: 204 });
      await harness.navigateByUrl(`/orgs/${ORG}/projects/${PROJECT}`);
      await settle();
      expect(row('old-token').querySelector('button')).toBeNull();
      await click(row('ci-deploy'), 'Revoke');
      fill('project-token-password', PASSWORD);
      await submit('Revoke token');
      expect(posts).toMatchObject([
        { path: `${PROJECT_PATH}/api-tokens/${M1}/revoke`, body: { password: PASSWORD } },
      ]);
      expect(element().textContent).toContain('The token has been revoked.');
      expect(element().querySelector('#project-token-password')).toBeNull();
    });

    it('removes only direct roles, on the project', async () => {
      routes[`POST ${PROJECT_PATH}/bindings/${M2}/remove`] = () => json({ binding: null });
      await harness.navigateByUrl(`/orgs/${ORG}/projects/${PROJECT}`);
      await settle();
      expect(row('owner@example.com').querySelector('button')).toBeNull();
      expect(row('dev@example.com').textContent).toContain('developer, from project');
      await click(row('dev@example.com'), 'Remove role');
      expect(row('dev@example.com').textContent).toContain('They lose access here.');
      fill('binding-remove-password', PASSWORD);
      await submit('Remove role');
      expect(posts).toMatchObject([
        { path: `${PROJECT_PATH}/bindings/${M2}/remove`, body: { password: PASSWORD } },
      ]);
    });

    it('gives the least privilege role unless another is chosen', async () => {
      routes[`POST ${PROJECT_PATH}/bindings`] = () => json({ binding: null });
      await harness.navigateByUrl(`/orgs/${ORG}/projects/${PROJECT}`);
      await settle();
      expect(control('binding-add-role').value).toBe('viewer');
      fill('binding-add-email', 'new@example.com');
      fill('binding-add-password', PASSWORD);
      await submit('Give role');
      expect(posts).toMatchObject([
        {
          path: `${PROJECT_PATH}/bindings`,
          body: { email: 'new@example.com', role: 'viewer', password: PASSWORD },
        },
      ]);
      expect(control('binding-add-password').value).toBe('');
    });

    it('uses the environment routes and explains what an override does', async () => {
      routes[`GET ${ENV_PATH}`] = () =>
        json({
          id: ENV,
          organizationId: ORG,
          projectId: PROJECT,
          name: 'production',
          kind: 'standard',
          failoverPolicy: 'none',
          protected: true,
          ...stamp,
        });
      routes[`GET ${ENV_PATH}/applications`] = () => page([]);
      routes[`GET ${ENV_PATH}/secrets`] = () => page([]);
      routes[`GET ${ENV_PATH}/bindings`] = () =>
        page([binding(M2, 'dev@example.com', 'viewer', 'environment', 'viewer', 'developer')]);
      routes[`POST ${ENV_PATH}/bindings/${M2}/remove`] = () => json({ binding: null });
      await harness.navigateByUrl(`/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}`);
      await settle();
      expect(element().textContent).toContain("replaces the person's project role here");
      await click(row('dev@example.com'), 'Remove role');
      expect(row('dev@example.com').textContent).toContain('keep the role developer');
      fill('binding-remove-password', PASSWORD);
      await submit('Remove role');
      expect(posts.at(-1)?.path).toBe(`${ENV_PATH}/bindings/${M2}/remove`);
    });
  });
});
