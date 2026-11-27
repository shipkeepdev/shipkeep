import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { IdentityRequestError } from '../identity/identity-api';
import { I18n } from '../ui/i18n';

import { GithubApi } from './github-api';
import { GithubReturnPage } from './github-return-page';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';

async function render(params: { code?: string; state?: string }, connect: () => Promise<unknown>) {
  const api = { connect: vi.fn(connect) };
  TestBed.configureTestingModule({
    imports: [GithubReturnPage],
    providers: [provideRouter([]), { provide: GithubApi, useValue: api }],
  });
  TestBed.inject(I18n).use('en');
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  const fixture = TestBed.createComponent(GithubReturnPage);
  fixture.componentRef.setInput('organizationId', ORG);
  if (params.code) fixture.componentRef.setInput('code', params.code);
  if (params.state) fixture.componentRef.setInput('state', params.state);
  fixture.detectChanges();
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    fixture.detectChanges();
  }
  await fixture.whenStable();
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return { api, navigate, root, text: () => root.textContent.replace(/\s+/g, ' ').trim() };
}

describe('the page GitHub sends an owner back to', () => {
  it('connects the App once, then leaves for the integrations without the code in the URL', async () => {
    const page = await render({ code: 'c0de', state: 's7a7e' }, () => Promise.resolve({}));
    expect(page.api.connect).toHaveBeenCalledWith(ORG, { code: 'c0de', state: 's7a7e' });
    expect(page.navigate).toHaveBeenCalledWith(['/orgs', ORG, 'integrations'], {
      replaceUrl: true,
      queryParams: { connected: 'github' },
    });
  });

  it('says a link without its code, or used already, must be started again', async () => {
    const missing = await render({}, () => Promise.resolve({}));
    expect(missing.api.connect).not.toHaveBeenCalled();
    expect(missing.text()).toContain('This link expired or was already used.');
    TestBed.resetTestingModule();
    const used = await render({ code: 'c', state: 's' }, () =>
      Promise.reject(new IdentityRequestError(400, 0, { code: 'github_app_flow_invalid' })),
    );
    expect(used.text()).toContain('This link expired or was already used.');
    expect(used.navigate).not.toHaveBeenCalled();
  });

  it('links the App GitHub created but Shipkeep could not keep, for its deletion', async () => {
    const page = await render({ code: 'c', state: 's' }, () =>
      Promise.reject(
        new IdentityRequestError(409, 0, {
          code: 'github_app_not_connected',
          appUrl: 'https://github.com/apps/shipkeep-acme-a1b2c3',
        }),
      ),
    );
    expect(page.text()).toContain('GitHub created the App, but Shipkeep could not keep it.');
    const link = page.root.querySelector<HTMLAnchorElement>('a[href^="https://github.com/apps/"]');
    expect(link?.href).toBe('https://github.com/apps/shipkeep-acme-a1b2c3');
  });

  it('says when GitHub could not be reached', async () => {
    const page = await render({ code: 'c', state: 's' }, () =>
      Promise.reject(new IdentityRequestError(503)),
    );
    expect(page.text()).toContain('GitHub could not be reached. Try again in a moment.');
  });
});
