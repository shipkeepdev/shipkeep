import { type ComponentFixture, TestBed } from '@angular/core/testing';

import { IDENTITY_FETCH } from '../identity/identity-api';

import { PROFILE_ONLY, type TokenGrant, TokenScopePicker } from './token-scope-picker';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const OTHER = '0190f5a8-7b1c-7e2d-8f3a-0000000000a1';
const PROJECT = '0190f5a8-7b1c-7e2d-8f3a-0000000000bb';
const ENV = '0190f5a8-7b1c-7e2d-8f3a-0000000000cc';
const stamp = { createdAt: '2026-11-07T12:00:00Z', updatedAt: '2026-11-07T12:00:00Z' };
const page = (items: unknown[]) =>
  new Response(JSON.stringify({ items, nextCursor: null }), {
    headers: { 'content-type': 'application/json' },
  });

describe('token scope picker', () => {
  let fixture: ComponentFixture<TokenScopePicker>;
  let grants: TokenGrant[];
  let refuseOrganizations: boolean;

  async function create(): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: IDENTITY_FETCH,
          useValue: (request: Request) => {
            const path = new URL(request.url).pathname;
            if (path === '/api/v1/organizations')
              return refuseOrganizations
                ? new Response('{}', { status: 500 })
                : page([
                    { id: ORG, name: 'Acme', slug: 'acme', ...stamp },
                    { id: OTHER, name: 'Other', slug: 'other', ...stamp },
                  ]);
            if (path.endsWith('/projects'))
              return page([{ id: PROJECT, organizationId: ORG, name: 'Billing', slug: 'billing' }]);
            return page([{ id: ENV, organizationId: ORG, projectId: PROJECT, name: 'production' }]);
          },
        },
      ],
    });
    fixture = TestBed.createComponent(TokenScopePicker);
    grants = [];
    fixture.componentInstance.grantChange.subscribe((grant) => grants.push(grant));
    await settle();
  }
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    fixture.detectChanges();
  }
  function element(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }
  async function choose(id: string, value: string): Promise<void> {
    const select = element().querySelector<HTMLSelectElement>(`#${id}`);
    if (!select) throw new Error(`missing ${id}`);
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await settle();
  }
  async function tick(id: string): Promise<void> {
    const box = element().querySelector<HTMLInputElement>(`[id="${id}"]`);
    if (!box) throw new Error(`missing ${id}`);
    box.click();
    await settle();
  }
  const offered = () =>
    [...element().querySelectorAll('input[type="checkbox"][id^="token-permission-"]')].map((box) =>
      box.id.replace('token-permission-', ''),
    );
  const grant = () => grants.at(-1);

  beforeEach(() => {
    refuseOrganizations = false;
  });

  it('starts with the account profile only', async () => {
    await create();
    expect(grant()).toEqual(PROFILE_ONLY);
    expect(element().textContent).toContain('can only read your account profile');
  });

  it('grants nothing on an organization until a permission is ticked', async () => {
    await create();
    await choose('token-organization', ORG);
    expect(grant()).toEqual({ scopes: [] });
    await tick('token-permission-audit.read');
    expect(grant()).toEqual({ scopes: [{ permission: 'audit.read', organizationId: ORG }] });
    await tick('token-permission-audit.read');
    expect(grant()).toEqual({ scopes: [] });
  });

  it('offers only permissions that can match a route at the chosen level', async () => {
    await create();
    await choose('token-organization', ORG);
    expect(offered()).toContain('audit.read');
    expect(offered()).toContain('deploy.run');
    expect(offered()).not.toContain('member.manage');
    expect(offered()).not.toContain('profile.read');
    await choose('token-project', PROJECT);
    expect(offered()).not.toContain('audit.read');
    expect(offered()).toContain('environment.create');
    await choose('token-environment', ENV);
    expect(offered()).toEqual([
      'environment.read',
      'environment.update',
      'deploy.run',
      'secret.write',
    ]);
  });

  it('narrows scopes and never keeps one the level no longer offers', async () => {
    await create();
    await choose('token-organization', ORG);
    await tick('token-permission-audit.read');
    await tick('token-permission-deploy.run');
    await choose('token-project', PROJECT);
    await choose('token-environment', ENV);
    expect(grant()).toEqual({
      scopes: [
        { permission: 'deploy.run', organizationId: ORG, projectId: PROJECT, environmentId: ENV },
      ],
    });
  });

  it('ties the token to a project only on request, and forgets that with the project', async () => {
    await create();
    await choose('token-organization', ORG);
    expect(element().querySelector('#token-bound')).toBeNull();
    await choose('token-project', PROJECT);
    await tick('token-permission-project.read');
    expect(grant()?.project).toBeUndefined();
    await tick('token-bound');
    expect(grant()).toEqual({
      scopes: [{ permission: 'project.read', organizationId: ORG, projectId: PROJECT }],
      project: { organizationId: ORG, projectId: PROJECT },
    });
    await choose('token-project', '');
    expect(grant()?.project).toBeUndefined();
  });

  it('clears everything when the organization changes', async () => {
    await create();
    await choose('token-organization', ORG);
    await tick('token-permission-audit.read');
    await choose('token-project', PROJECT);
    await choose('token-organization', OTHER);
    expect(grant()).toEqual({ scopes: [] });
    await choose('token-organization', '');
    expect(grant()).toEqual(PROFILE_ONLY);
  });

  it('stays on the profile when organizations cannot be loaded', async () => {
    refuseOrganizations = true;
    await create();
    expect(element().querySelector('[role="alert"]')).not.toBeNull();
    expect(grant()).toEqual(PROFILE_ONLY);
  });
});
