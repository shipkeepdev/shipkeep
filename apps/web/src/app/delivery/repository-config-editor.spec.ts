import { TestBed } from '@angular/core/testing';

import { IdentityRequestError } from '../identity/identity-api';
import { I18n } from '../ui/i18n';

import {
  type Application,
  DeliveryApi,
  type RepositoryConfig,
  type RepositoryConfigPreview,
} from './delivery-api';
import { RepositoryConfigEditor } from './repository-config-editor';

const env = {
  organizationId: '0190f5a8-7b1c-7e2d-8f3a-0000000000aa',
  projectId: '0190f5a8-7b1c-7e2d-8f3a-0000000000bb',
  environmentId: '0190f5a8-7b1c-7e2d-8f3a-0000000000cc',
};
const HEAD = 'a1b2c3d'.padEnd(40, '0');
const APPLIED = '9f8e7d6'.padEnd(40, '0');
const BLOB = 'b'.repeat(40);
const TEXT =
  '# Billing\nversion: 1\nname: billing\nbuild:\n  type: dockerfile\nrun:\n  port: 3000\n';
const application = {
  id: '0190f5a8-7b1c-7e2d-8f3a-0000000000dd',
  name: 'billing',
  source: 'git',
  repository: {
    installationId: 1,
    repositoryId: 2,
    fullName: 'acme-corp/billing',
    branch: 'main',
    configPath: 'shipkeep.yml',
    commitSha: HEAD,
  },
} as unknown as Application;
const file = (overrides: Partial<RepositoryConfig> = {}): RepositoryConfig => ({
  fullName: 'acme-corp/billing',
  branch: 'main',
  configPath: 'shipkeep.yml',
  commitSha: HEAD,
  blobSha: BLOB,
  text: TEXT,
  appliedCommitSha: HEAD,
  valid: true,
  applied: true,
  ...overrides,
});
const preview = (writeMode: 'commit' | 'pull_request'): RepositoryConfigPreview => ({
  ...file(),
  changedText: `${TEXT}scale:\n  replicas: 3\n`,
  diff: [
    { kind: 'skipped', count: 4 },
    { kind: 'same', text: 'run:' },
    { kind: 'same', text: '  port: 3000' },
    { kind: 'added', text: 'scale:' },
    { kind: 'added', text: '  replicas: 3' },
  ],
  writeMode,
});

function setup(first: RepositoryConfig | Error = file()) {
  const api = {
    repositoryConfig: vi.fn(() =>
      first instanceof Error ? Promise.reject(first) : Promise.resolve(first),
    ),
    previewRepositoryConfig: vi.fn((..._args: unknown[]) =>
      Promise.resolve(preview('pull_request')),
    ),
    changeRepositoryConfig: vi.fn((..._args: unknown[]) =>
      Promise.resolve({
        via: 'pull_request' as const,
        commitSha: 'c'.repeat(40),
        url: 'https://github.com/acme-corp/billing/pull/12',
        number: 12,
        branch: 'shipkeep/config-0123456789ab',
      }),
    ),
  };
  TestBed.configureTestingModule({
    imports: [RepositoryConfigEditor],
    providers: [{ provide: DeliveryApi, useValue: api }],
  });
  TestBed.inject(I18n).use('en');
  const fixture = TestBed.createComponent(RepositoryConfigEditor);
  fixture.componentRef.setInput('application', application);
  fixture.componentRef.setInput('environment', env);
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      fixture.detectChanges();
    }
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const button = (label: string) =>
    [...root().querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.textContent.trim() === label,
    );
  const editor = () => root().querySelector<HTMLTextAreaElement>('#configuration-draft');
  const type = (value: string) => {
    const area = editor();
    if (!area) throw new Error('no editor');
    area.value = value;
    area.dispatchEvent(new Event('input'));
  };
  const review = async () => {
    root().querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();
  };
  return {
    api,
    settle,
    button,
    editor,
    type,
    review,
    root,
    text: () => root().textContent.replace(/\s+/g, ' ').trim(),
  };
}

describe("a Git application's shipkeep.yml, edited here (#214)", () => {
  it('starts from the repository’s file, comments included, and says that the application runs it', async () => {
    const page = setup();
    await page.settle();
    expect(page.editor()?.value).toBe(TEXT);
    expect(page.text()).toContain('The application runs this file, at commit a1b2c3d.');
  });

  it('says when the file changed in the repository, or is not valid for this application', async () => {
    const drift = setup(file({ applied: false, appliedCommitSha: APPLIED }));
    await drift.settle();
    expect(drift.text()).toContain(
      'this application runs the one of commit 9f8e7d6, and main is at a1b2c3d.',
    );
    TestBed.resetTestingModule();
    const invalid = setup(file({ valid: false, applied: false }));
    await invalid.settle();
    expect(invalid.text()).toContain('is not a valid configuration for this application');
  });

  it('reviews the exact lines written, then opens a pull request with the document reviewed', async () => {
    const page = setup();
    await page.settle();
    page.type(`${TEXT}scale:\n  replicas: 3\n`);
    await page.review();
    expect(page.api.previewRepositoryConfig).toHaveBeenCalledWith(
      env,
      application.id,
      expect.objectContaining({ name: 'billing', scale: { replicas: 3 } }),
      BLOB,
    );
    const diff = page.root().querySelector('pre')?.textContent ?? '';
    expect(diff).toContain('⋯ 4 unchanged lines');
    expect(diff).toContain('+ scale:');
    expect(diff).toContain('+   replicas: 3');
    expect(page.text()).toContain('It goes to a branch of its own, in a pull request into main.');
    // The review replaced its button: the focus is on the next step.
    expect(document.activeElement).toBe(page.button('Open a pull request'));
    page.button('Open a pull request')?.click();
    await page.settle();
    // With a key: a retry after a lost answer gets the first answer, not a second pull request.
    expect(page.api.changeRepositoryConfig).toHaveBeenCalledWith(
      env,
      application.id,
      expect.objectContaining({ scale: { replicas: 3 } }),
      BLOB,
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    );
    expect(page.text()).toContain(
      'Pull request #12 opened. Merging it into main deploys the change, unless the environment is protected.',
    );
    expect(document.activeElement?.getAttribute('role')).toBe('status');
    expect(page.root().querySelector<HTMLAnchorElement>('a[href]')?.href).toBe(
      'https://github.com/acme-corp/billing/pull/12',
    );
    // The change is in the pull request: the draft starts again from the branch's file.
    expect(page.root().querySelector('pre')).toBeNull();
    expect(page.editor()?.value).toBe(TEXT);
    expect(page.api.repositoryConfig).toHaveBeenCalledTimes(2);
  });

  it('goes back to the draft from a review, with the focus in the editor', async () => {
    const page = setup();
    await page.settle();
    page.type(`${TEXT}scale:\n  replicas: 3\n`);
    await page.review();
    page.button('Back to editing')?.click();
    await page.settle();
    expect(page.root().querySelector('pre')).toBeNull();
    expect(page.editor()?.value).toBe(`${TEXT}scale:\n  replicas: 3\n`);
    expect(document.activeElement).toBe(page.editor());
  });

  it('keeps a draft started while the file is read again after a write', async () => {
    const page = setup();
    await page.settle();
    page.type(`${TEXT}scale:\n  replicas: 3\n`);
    await page.review();
    let answer: (file: RepositoryConfig) => void = () => undefined;
    page.api.repositoryConfig.mockImplementationOnce(
      () => new Promise<RepositoryConfig>((resolve) => (answer = resolve)),
    );
    page.button('Open a pull request')?.click();
    await page.settle();
    // The next change, typed before the branch's file came back.
    const next = `${TEXT}scale:\n  replicas: 4\n`;
    page.type(next);
    answer(file());
    await page.settle();
    expect(page.editor()?.value).toBe(next);
  });

  it('commits when the project says so', async () => {
    const page = setup();
    page.api.previewRepositoryConfig.mockImplementationOnce(() =>
      Promise.resolve(preview('commit')),
    );
    await page.settle();
    page.type(`${TEXT}scale:\n  replicas: 3\n`);
    await page.review();
    expect(page.text()).toContain('If main is protected, a pull request is opened instead.');
    expect(page.button('Commit to main')).toBeDefined();
  });

  it('keeps the draft when the file changed in the repository, and reviews it against the latest', async () => {
    const page = setup();
    page.api.previewRepositoryConfig.mockImplementationOnce(() =>
      Promise.reject(new IdentityRequestError(409, 0, { code: 'config_file_changed' })),
    );
    await page.settle();
    const draft = `${TEXT}scale:\n  replicas: 3\n`;
    page.type(draft);
    await page.review();
    expect(page.text()).toContain('The file changed in the repository since you opened it.');
    expect(page.button('Review changes')?.disabled).toBe(true);
    page.api.repositoryConfig.mockImplementationOnce(() =>
      Promise.resolve(file({ blobSha: 'd'.repeat(40) })),
    );
    page.button('Load the latest file')?.click();
    await page.settle();
    expect(page.editor()?.value).toBe(draft);
    expect(page.text()).toContain('Your draft is unchanged: review it again.');
    await page.review();
    expect(page.api.previewRepositoryConfig).toHaveBeenLastCalledWith(
      env,
      application.id,
      expect.anything(),
      'd'.repeat(40),
    );
  });

  it('refuses here a draft that is not valid, renames the application or changes nothing', async () => {
    const page = setup();
    page.api.previewRepositoryConfig.mockImplementation(() =>
      Promise.resolve({ ...preview('pull_request'), diff: [], changedText: TEXT }),
    );
    await page.settle();
    page.type('version: 1\nname: [broken\n');
    await page.review();
    expect(page.editor()?.getAttribute('aria-invalid')).toBe('true');
    page.type(TEXT.replace('name: billing', 'name: renamed'));
    await page.review();
    expect(page.text()).toContain('The application name cannot be changed.');
    expect(page.api.previewRepositoryConfig).not.toHaveBeenCalled();
    page.type(TEXT);
    await page.review();
    expect(page.text()).toContain(
      'This draft leaves the file as it is: there is nothing to write.',
    );
    expect(page.button('Open a pull request')).toBeUndefined();
  });

  it('says when the file could not be read, and reads it again', async () => {
    const page = setup(new Error('offline'));
    await page.settle();
    expect(page.text()).toContain('The file could not be read from the repository.');
    expect(page.editor()).toBeNull();
    page.api.repositoryConfig.mockImplementationOnce(() => Promise.resolve(file()));
    page.button('Try again')?.click();
    await page.settle();
    expect(page.editor()?.value).toBe(TEXT);
  });
});
