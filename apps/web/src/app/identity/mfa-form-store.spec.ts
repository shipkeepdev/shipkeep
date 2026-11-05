import { TestBed } from '@angular/core/testing';

import { IdentityApi, IdentityRequestError } from './identity-api';
import { MfaFormStore } from './mfa-form-store';
import { MutationRunner } from './mutation-runner';
import { SessionStore } from './session-store';

describe('MFA form lifecycle', () => {
  const password = 'correct horse browser fixture';
  const profile = {
    userId: 'fixture',
    email: 'person@example.com',
    expiresAt: '2030-01-01T00:00:00Z',
  };
  const codes = Array.from({ length: 10 }, (_, i) => i.toString(16).padStart(32, '0'));
  const api = {
    mfaStatus: vi.fn<IdentityApi['mfaStatus']>(),
    setupMfa: vi.fn<IdentityApi['setupMfa']>(),
    enableMfa: vi.fn<IdentityApi['enableMfa']>(),
    disableMfa: vi.fn<IdentityApi['disableMfa']>(),
    regenerateRecovery: vi.fn<IdentityApi['regenerateRecovery']>(),
  };
  let store: MfaFormStore;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    api.mfaStatus.mockResolvedValue({
      enabled: false,
      pendingExpiresAt: null,
      recoveryCodesRemaining: 0,
    });
    TestBed.configureTestingModule({
      providers: [MfaFormStore, MutationRunner, { provide: IdentityApi, useValue: api }],
    });
    TestBed.inject(SessionStore).accept(profile);
    store = TestBed.inject(MfaFormStore);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('distinguishes unavailable MFA status from disabled MFA and expired sessions', async () => {
    api.mfaStatus.mockRejectedValueOnce(new IdentityRequestError(503));
    await store.load();
    expect(store.status()).toBeNull();
    expect(store.state()).toBe('unavailable');
    expect(store.begin('setup')).toBe(false);
    api.mfaStatus.mockRejectedValueOnce(new IdentityRequestError(401));
    await store.load();
    expect(TestBed.inject(SessionStore).profile()).toBeNull();
  });
  it('requires reauthentication and bounds provisioning data to its lifetime', async () => {
    await store.load();
    store.begin('setup');
    await store.submit();
    expect(api.setupMfa).not.toHaveBeenCalled();
    const secret = 'A'.repeat(32);
    api.setupMfa.mockResolvedValue({
      secret,
      provisioningUri: 'otpauth://totp/private-fixture',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    });
    store.form.controls.password.setValue(password);
    await store.submit();
    expect(store.mode()).toBe('enable');
    expect(store.setup()?.secret).toBe(secret);
    expect(store.form.controls.password.value).toBe('');
    expect(JSON.stringify(store)).not.toContain(secret);
    vi.advanceTimersByTime(600000);
    expect(store.setup()).toBeNull();
    expect(store.notice()).toContain('expired');
    store.form.patchValue({ password, factor: '123456' });
    await store.submit();
    expect(api.enableMfa).not.toHaveBeenCalled();
  });
  async function stage(): Promise<void> {
    await store.load();
    store.begin('setup');
    api.setupMfa.mockResolvedValue({
      secret: 'A'.repeat(32),
      provisioningUri: 'otpauth://totp/private-fixture',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    });
    store.form.controls.password.setValue(password);
    await store.submit();
  }
  it('activates with one six-digit proof and keeps recovery codes out of the session', async () => {
    await stage();
    api.enableMfa.mockResolvedValue({ ...profile, recoveryCodes: codes });
    api.mfaStatus.mockResolvedValue({
      enabled: true,
      pendingExpiresAt: null,
      recoveryCodesRemaining: 10,
    });
    store.form.patchValue({ password, factor: ' 123456 ' });
    await store.submit();
    expect(api.enableMfa).toHaveBeenCalledWith({ password, totp: '123456' }, expect.any(String));
    expect(store.setup()).toBeNull();
    expect(store.recoveryCodes()).toEqual(codes);
    expect(TestBed.inject(SessionStore).profile()).toEqual(profile);
    expect(store.form.controls.password.value).toBe('');
    store.dismiss();
    expect(store.recoveryCodes()).toEqual([]);
  });
  it('disables or replaces recovery codes only with a required current proof', async () => {
    api.mfaStatus.mockResolvedValue({
      enabled: true,
      pendingExpiresAt: null,
      recoveryCodesRemaining: 10,
    });
    await store.load();
    store.begin('disable');
    store.form.controls.password.setValue(password);
    await store.submit();
    expect(api.disableMfa).not.toHaveBeenCalled();
    api.disableMfa.mockResolvedValue(profile);
    store.form.controls.factorKind.setValue('recovery');
    store.form.controls.factor.setValue('a'.repeat(32));
    await store.submit();
    expect(api.disableMfa).toHaveBeenCalledWith(
      { password, recovery: 'a'.repeat(32) },
      expect.any(String),
    );
    store.begin('recovery');
    api.regenerateRecovery.mockResolvedValue({ ...profile, recoveryCodes: codes });
    store.form.patchValue({ password, factor: '123456' });
    await store.submit();
    expect(api.regenerateRecovery).toHaveBeenCalledWith(
      { password, totp: '123456' },
      expect.any(String),
    );
    // Recovery codes are shown once by the server: no timer may hide them before acknowledgement.
    vi.advanceTimersByTime(3600000);
    expect(store.recoveryCodes()).toEqual(codes);
  });
  it('shares the account mutation gate and prevents cancel/restart while a request is pending', async () => {
    await stage();
    const runner = TestBed.inject(MutationRunner);
    let finish: (() => void) | undefined;
    const pending = runner.run(
      {},
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    expect(store.begin('setup')).toBe(false);
    store.dismiss();
    expect(store.setup()).not.toBeNull();
    finish?.();
    await pending;
    store.dismiss();
    expect(store.setup()).toBeNull();
  });
  it('destroys all private grants and rejects a late response from the departed page', async () => {
    await store.load();
    store.begin('setup');
    let finish: ((value: Awaited<ReturnType<IdentityApi['setupMfa']>>) => void) | undefined;
    api.setupMfa.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    store.form.controls.password.setValue(password);
    const pending = store.submit();
    TestBed.resetTestingModule();
    finish?.({
      secret: 'A'.repeat(32),
      provisioningUri: 'otpauth://totp/private-fixture',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    });
    await pending;
    expect(store.setup()).toBeNull();
    expect(store.form.controls.password.value).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not discard recovery codes when setup expires during a valid in-flight activation', async () => {
    await stage();
    let finish: ((value: Awaited<ReturnType<IdentityApi['enableMfa']>>) => void) | undefined;
    api.enableMfa.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    store.form.patchValue({ password, factor: '123456' });
    const pending = store.submit();
    vi.advanceTimersByTime(600000);
    expect(store.setup()).toBeNull();
    expect(store.form.controls.password.value).toBe('');
    finish?.({ ...profile, recoveryCodes: codes });
    await pending;
    expect(store.recoveryCodes()).toEqual(codes);
  });
});
