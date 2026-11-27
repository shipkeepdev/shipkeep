import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { IdentityRequestError } from '../identity/identity-api';
import { type GithubApp, GithubApi, type GithubRepositories } from '../integrations/github-api';
import { I18n } from '../ui/i18n';

import { type Application, DeliveryApi } from './delivery-api';
import { GithubApplicationForm } from './github-application-form';

const ENVIRONMENT = {
  organizationId: '0190f5a8-7b1c-7e2d-8f3a-0000000000aa',
  projectId: '0190f5a8-7b1c-7e2d-8f3a-0000000000ab',
  environmentId: '0190f5a8-7b1c-7e2d-8f3a-0000000000ac',
};
const app = { appId: 42, name: 'Shipkeep acme' } as GithubApp;
const listing: GithubRepositories = {
  repositories: [
    {
      installationId: 7,
      id: 501,
      fullName: 'acme-corp/billing',
      defaultBranch: 'main',
      private: true,
    },
    {
      installationId: 7,
      id: 502,
      fullName: 'acme-corp/site',
      defaultBranch: 'trunk',
      private: false,
    },
  ],
  truncated: false,
  unreachable: [],
};

function setup(options: { app?: GithubApp | null; repositories?: GithubRepositories }) {
  const github = {
    app: vi.fn(() => Promise.resolve(options.app === undefined ? app : options.app)),
    repositories: vi.fn(() => Promise.resolve(options.repositories ?? listing)),
  };
  const delivery = {
    createGithubApplication: vi.fn((_environment: unknown, _body: unknown) =>
      Promise.resolve({ id: 'created' } as Application),
    ),
  };
  TestBed.configureTestingModule({
    imports: [GithubApplicationForm],
    providers: [
      provideRouter([]),
      { provide: GithubApi, useValue: github },
      { provide: DeliveryApi, useValue: delivery },
    ],
  });
  TestBed.inject(I18n).use('en');
  const fixture = TestBed.createComponent(GithubApplicationForm);
  fixture.componentRef.setInput('environment', ENVIRONMENT);
  const created: Application[] = [];
  fixture.componentInstance.created.subscribe((application) => created.push(application));
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      fixture.detectChanges();
    }
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const field = (id: string) => {
    const element = root().querySelector(`#${id}`);
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement))
      throw new Error(`no #${id}`);
    return element;
  };
  return {
    delivery,
    created,
    root,
    settle,
    field,
    text: () => root().textContent.replace(/\s+/g, ' ').trim(),
    submit: () =>
      [...root().querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent.includes('Create application'))
        ?.click(),
  };
}

describe('an application from a GitHub repository', () => {
  it('sends the repository chosen, its branch and the path, and says it was created', async () => {
    const form = setup({});
    await form.settle();
    expect(form.field('github-branch').value).toBe('main');
    const select = form.field('github-repository');
    select.value = '7:502';
    select.dispatchEvent(new Event('change'));
    await form.settle();
    // Another repository proposes its own default branch.
    expect(form.field('github-branch').value).toBe('trunk');
    const path = form.field('github-config-path');
    path.value = ' deploy/shipkeep.yml ';
    path.dispatchEvent(new Event('input'));
    form.submit();
    await form.settle();
    expect(form.delivery.createGithubApplication).toHaveBeenCalledWith(ENVIRONMENT, {
      installationId: 7,
      repositoryId: 502,
      branch: 'trunk',
      configPath: 'deploy/shipkeep.yml',
    });
    expect(form.created).toEqual([{ id: 'created' }]);
  });

  it('says what each refusal means, in its own words', async () => {
    const form = setup({});
    await form.settle();
    form.delivery.createGithubApplication.mockRejectedValueOnce(
      new IdentityRequestError(400, 0, { code: 'github_branch_not_found' }),
    );
    form.submit();
    await form.settle();
    expect(form.text()).toContain('This branch does not exist in the repository.');
    form.delivery.createGithubApplication.mockRejectedValueOnce(
      new IdentityRequestError(400, 0, { code: 'unsupported_build_type' }),
    );
    form.submit();
    await form.settle();
    expect(form.text()).toContain('Building from the repository is not supported yet');
    expect(form.created).toEqual([]);
  });

  it('sends an organization without a GitHub App to the integrations', async () => {
    const form = setup({ app: null });
    await form.settle();
    expect(form.text()).toContain('Connect GitHub first');
    expect(form.root().querySelector('a')?.getAttribute('href')).toBe(
      `/orgs/${ENVIRONMENT.organizationId}/integrations`,
    );
    expect(form.root().querySelector('form')).toBeNull();
  });

  it('says when the App reaches no repository yet', async () => {
    const form = setup({ repositories: { repositories: [], truncated: false, unreachable: [] } });
    await form.settle();
    expect(form.text()).toContain('The GitHub App reaches no repository yet');
    expect(form.root().querySelector('form')).toBeNull();
  });
});
