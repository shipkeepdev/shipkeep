import { TestBed } from '@angular/core/testing';

import { IdentityApi } from './identity-api';
import { MfaFormStore } from './mfa-form-store';
import { MfaPanel } from './mfa-panel';
import { MutationRunner } from './mutation-runner';
import { PRIVATE_CLIPBOARD } from './private-clipboard';
import { SessionStore } from './session-store';

describe('MFA screen', () => {
  it('enrolls with a manual key, displays private recovery codes and removes them on acknowledgement', async () => {
    const profile = {
      userId: 'fixture',
      email: 'person@example.com',
      expiresAt: '2030-01-01T00:00:00Z',
    };
    const codes = Array.from({ length: 10 }, (_, i) => i.toString(16).padStart(32, '0'));
    const write = vi.fn<(value: string) => Promise<void>>();
    const api = {
      mfaStatus: vi
        .fn()
        .mockResolvedValue({ enabled: false, pendingExpiresAt: null, recoveryCodesRemaining: 0 }),
      setupMfa: vi.fn().mockResolvedValue({
        secret: 'A'.repeat(32),
        provisioningUri: 'otpauth://totp/private-fixture',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      }),
      enableMfa: vi.fn().mockResolvedValue({ ...profile, recoveryCodes: codes }),
    };
    TestBed.configureTestingModule({
      imports: [MfaPanel],
      providers: [
        MutationRunner,
        { provide: IdentityApi, useValue: api },
        { provide: PRIVATE_CLIPBOARD, useValue: write },
      ],
    });
    TestBed.inject(SessionStore).accept(profile);
    const fixture = TestBed.createComponent(MfaPanel);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const store = fixture.debugElement.injector.get(MfaFormStore);
    const click = async (text: string) => {
      const button = Array.from(element.querySelectorAll('button')).find(
        (button) => button.textContent.trim() === text,
      );
      if (!button) throw new Error(`missing control: ${text}`);
      button.click();
      await fixture.whenStable();
    };
    await click('Set up two-factor authentication');
    store.form.controls.password.setValue('correct horse browser fixture');
    element
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(element.querySelector<HTMLInputElement>('#mfa-key')?.value).toBe('A'.repeat(32));
    expect(element.innerHTML).not.toContain('otpauth:');
    expect(write).not.toHaveBeenCalled();
    await click('Copy setup key');
    expect(write).toHaveBeenLastCalledWith('A'.repeat(32));
    expect(element.textContent).toContain('invalidates existing API tokens');
    api.mfaStatus.mockResolvedValue({
      enabled: true,
      pendingExpiresAt: null,
      recoveryCodesRemaining: 10,
    });
    store.form.patchValue({ password: 'correct horse browser fixture', factor: '123456' });
    element
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(element.querySelector('#mfa-key')).toBeNull();
    expect(element.querySelectorAll('li')).toHaveLength(10);
    await click('Copy recovery codes');
    expect(write).toHaveBeenLastCalledWith(codes.join('\n'));
    await click('I have saved these codes');
    expect(element.querySelectorAll('li')).toHaveLength(0);
    expect(store.recoveryCodes()).toEqual([]);
  });
});
