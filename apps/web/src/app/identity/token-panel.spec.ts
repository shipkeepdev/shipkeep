import { TestBed } from '@angular/core/testing';

import { IdentityApi, type IdentitySchema } from './identity-api';
import { MutationRunner } from './mutation-runner';
import { PRIVATE_CLIPBOARD } from './private-clipboard';
import { SessionStore } from './session-store';
import { TokenFormStore } from './token-form-store';
import { TokenPanel } from './token-panel';

describe('API-token screen', () => {
  it('creates/copies a credential explicitly and clears it when MFA rotates the session', async () => {
    const profile = {
      userId: 'fixture',
      email: 'person@example.com',
      expiresAt: '2030-01-01T00:00:00Z',
    };
    const token: IdentitySchema<'ApiTokenDto'> = {
      id: '018f4400-0000-7000-8000-000000000001',
      name: 'Profile reader',
      scopes: [{ permission: 'profile.read' }],
      status: 'active',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      revokedAt: null,
      lastUsedAt: null,
      project: null,
    };
    const api = {
      listTokens: vi.fn<IdentityApi['listTokens']>(),
      mfaStatus: vi.fn<IdentityApi['mfaStatus']>(),
      createToken: vi.fn<IdentityApi['createToken']>(),
    };
    api.listTokens.mockResolvedValue({ items: [], nextCursor: null });
    api.mfaStatus.mockResolvedValue({
      enabled: false,
      pendingExpiresAt: null,
      recoveryCodesRemaining: 0,
    });
    api.createToken.mockResolvedValue({ ...token, token: 'B'.repeat(43) });
    const write = vi.fn<(value: string) => Promise<void>>();
    TestBed.configureTestingModule({
      imports: [TokenPanel],
      providers: [
        MutationRunner,
        { provide: IdentityApi, useValue: api },
        { provide: PRIVATE_CLIPBOARD, useValue: write },
      ],
    });
    const session = TestBed.inject(SessionStore);
    session.accept(profile);
    const fixture = TestBed.createComponent(TokenPanel);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const store = fixture.debugElement.injector.get(TokenFormStore);
    const click = async (text: string) => {
      const button = Array.from(element.querySelectorAll('button')).find(
        (button) => button.textContent.trim() === text,
      );
      if (!button) throw new Error(`missing control: ${text}`);
      button.click();
      await fixture.whenStable();
    };
    expect(element.textContent).toContain('No API tokens yet');
    await click('Create API token');
    store.form.patchValue({ name: token.name, password: 'correct horse browser fixture' });
    api.listTokens.mockResolvedValue({ items: [token], nextCursor: null });
    element
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(element.querySelector<HTMLInputElement>('#new-token')?.value).toBe('B'.repeat(43));
    expect(write).not.toHaveBeenCalled();
    await click('Copy API token');
    expect(write).toHaveBeenCalledWith('B'.repeat(43));
    api.listTokens.mockResolvedValue({
      items: [{ ...token, status: 'invalidated' }],
      nextCursor: null,
    });
    api.mfaStatus.mockResolvedValue({
      enabled: true,
      pendingExpiresAt: null,
      recoveryCodesRemaining: 10,
    });
    session.accept(profile);
    await fixture.whenStable();
    expect(element.querySelector('#new-token')).toBeNull();
    expect(store.credential()).toBeNull();
    expect(element.textContent).toContain('Security settings changed');
    expect(
      element.querySelector<HTMLButtonElement>('button[aria-label="Revoke token Profile reader"]')
        ?.disabled,
    ).toBe(true);
  });
});
