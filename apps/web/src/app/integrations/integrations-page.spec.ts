import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { IdentityRequestError } from '../identity/identity-api';
import { ShellContext } from '../shell/shell-context';
import { I18n } from '../ui/i18n';

import { type GithubApp, GithubApi, type GithubRepositories } from './github-api';
import { IntegrationsPage } from './integrations-page';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const app: GithubApp = {
  appId: 42,
  slug: 'shipkeep-acme-a1b2c3',
  name: 'Shipkeep acme a1b2c3',
  ownerLogin: 'acme-corp',
  url: 'https://github.com/apps/shipkeep-acme-a1b2c3',
  createdAt: '2026-11-27T09:00:00Z',
};
const listing: GithubRepositories = {
  repositories: [
    {
      installationId: 7,
      id: 501,
      fullName: 'acme-corp/billing',
      defaultBranch: 'main',
      private: true,
    },
  ],
  truncated: false,
  unreachable: [],
};

function setup(options: {
  app?: GithubApp | null;
  role?: string;
  repositories?: () => Promise<GithubRepositories>;
}) {
  const api = {
    app: vi.fn(() => Promise.resolve(options.app ?? null)),
    repositories: vi.fn(options.repositories ?? (() => Promise.resolve(listing))),
    startManifest: vi.fn((_organizationId: string, _body: unknown) =>
      Promise.resolve({
        url: 'https://github.com/settings/apps/new?state=abc',
        manifest: '{"name":"Shipkeep acme a1b2c3"}',
      }),
    ),
  };
  TestBed.configureTestingModule({
    imports: [IntegrationsPage],
    providers: [
      { provide: GithubApi, useValue: api },
      { provide: ShellContext, useValue: { role: signal(options.role ?? 'owner') } },
    ],
  });
  TestBed.inject(I18n).use('en');
  const fixture = TestBed.createComponent(IntegrationsPage);
  fixture.componentRef.setInput('organizationId', ORG);
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      fixture.detectChanges();
    }
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return {
    api,
    root,
    settle,
    text: () => root().textContent.replace(/\s+/g, ' ').trim(),
    button: (label: string) =>
      [...root().querySelectorAll<HTMLButtonElement>('button')].find(
        (element) => element.textContent.trim() === label,
      ),
  };
}

describe('the integrations page', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const form of document.querySelectorAll('body > form')) form.remove();
  });

  it('lets an owner create the GitHub App: the manifest is posted to GitHub, as a form', async () => {
    const submitted: HTMLFormElement[] = [];
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (
      this: HTMLFormElement,
    ) {
      submitted.push(this);
    });
    const page = setup({});
    await page.settle();
    expect(page.text()).toContain('GitLab, Gitea and Bitbucket are planned.');
    page.button('Create the GitHub App')?.click();
    await page.settle();
    expect(page.api.startManifest).toHaveBeenCalledWith(ORG, { owner: 'user' });
    expect(submitted).toHaveLength(1);
    const form = submitted.at(0);
    expect(form?.method).toBe('post');
    expect(form?.action).toBe('https://github.com/settings/apps/new?state=abc');
    expect(form?.querySelector<HTMLInputElement>('input[name="manifest"]')?.value).toBe(
      '{"name":"Shipkeep acme a1b2c3"}',
    );
  });

  it('names the GitHub organization when the App goes there', async () => {
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined);
    const page = setup({});
    await page.settle();
    page.root().querySelector<HTMLInputElement>('input[value="organization"]')?.click();
    await page.settle();
    const field = page.root().querySelector<HTMLInputElement>('#github-organization');
    if (!field) throw new Error('no organization field');
    field.value = ' acme-corp ';
    field.dispatchEvent(new Event('input'));
    page.button('Create the GitHub App')?.click();
    await page.settle();
    expect(page.api.startManifest).toHaveBeenCalledWith(ORG, {
      owner: 'organization',
      githubOrganization: 'acme-corp',
    });
  });

  it('never posts the manifest anywhere but GitHub', async () => {
    const submit = vi
      .spyOn(HTMLFormElement.prototype, 'submit')
      .mockImplementation(() => undefined);
    const page = setup({});
    page.api.startManifest.mockResolvedValueOnce({
      url: 'https://evil.example/apps',
      manifest: '{}',
    });
    await page.settle();
    page.button('Create the GitHub App')?.click();
    await page.settle();
    expect(submit).not.toHaveBeenCalled();
  });

  it('tells others that an owner creates it', async () => {
    const page = setup({ role: 'admin' });
    await page.settle();
    expect(page.text()).toContain('An owner of the organization creates it.');
    expect(page.button('Create the GitHub App')).toBeUndefined();
  });

  it('shows the App, where to install it, and the repositories it reaches', async () => {
    const page = setup({ app });
    await page.settle();
    expect(page.text()).toContain('Shipkeep acme a1b2c3');
    expect(page.text()).toContain('On the GitHub account acme-corp');
    expect(page.text()).toContain('acme-corp/billing');
    expect(page.text()).toContain('default branch main');
    const links = [...page.root().querySelectorAll<HTMLAnchorElement>('a')].map((a) => a.href);
    expect(links).toContain(`${app.url}/installations/new`);
    expect(links).toContain(app.url);
  });

  it('says when GitHub could not be reached for the repositories, and asks again', async () => {
    let fail = true;
    const page = setup({
      app,
      repositories: () =>
        fail ? Promise.reject(new IdentityRequestError(503)) : Promise.resolve(listing),
    });
    await page.settle();
    expect(page.text()).toContain('GitHub could not be reached. Try again in a moment.');
    fail = false;
    page.button('Try again')?.click();
    await page.settle();
    expect(page.text()).toContain('acme-corp/billing');
  });
});
