import { TestBed } from '@angular/core/testing';

import { IdentityApi, IdentityRequestError, type IdentitySchema } from './identity-api';
import { MutationRunner } from './mutation-runner';
import { SessionStore } from './session-store';
import { TokenFormStore } from './token-form-store';

describe('API-token forms', () => {
  const password = 'correct horse browser fixture';
  const token: IdentitySchema<'ApiTokenDto'> = {
    id: '018f4400-0000-7000-8000-000000000001',
    name: 'Profile reader',
    scopes: [{ permission: 'profile.read' }],
    status: 'active',
    createdAt: '2026-11-01T00:00:00Z',
    expiresAt: '2026-12-01T00:00:00Z',
    revokedAt: null,
    lastUsedAt: null,
  };
  const api = {
    listTokens: vi.fn<IdentityApi['listTokens']>(),
    mfaStatus: vi.fn<IdentityApi['mfaStatus']>(),
    createToken: vi.fn<IdentityApi['createToken']>(),
    revokeToken: vi.fn<IdentityApi['revokeToken']>(),
  };
  let store: TokenFormStore;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    api.listTokens.mockResolvedValue({ items: [token], nextCursor: null });
    api.mfaStatus.mockResolvedValue({
      enabled: false,
      pendingExpiresAt: null,
      recoveryCodesRemaining: 0,
    });
    TestBed.configureTestingModule({
      providers: [TokenFormStore, MutationRunner, { provide: IdentityApi, useValue: api }],
    });
    store = TestBed.inject(TokenFormStore);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('keeps one metadata page and navigates forward/back without accumulating credentials', async () => {
    api.listTokens.mockResolvedValueOnce({ items: [token], nextCursor: token.id });
    await store.refresh();
    api.listTokens.mockResolvedValueOnce({
      items: [{ ...token, id: '018f4400-0000-7000-8000-000000000002' }],
      nextCursor: null,
    });
    await store.nextPage();
    expect(api.listTokens).toHaveBeenLastCalledWith(token.id);
    expect(store.items()).toHaveLength(1);
    expect(store.page()).toBe(1);
    await store.previousPage();
    expect(api.listTokens).toHaveBeenLastCalledWith(undefined);
    expect(store.page()).toBe(0);
  });
  it('validates names/lifetimes and preserves the absolute expiry and key across uncertain retries', async () => {
    await store.refresh();
    store.beginCreate();
    store.form.patchValue({ name: 'bad\nname', password });
    await store.submit();
    expect(api.createToken).not.toHaveBeenCalled();
    store.form.patchValue({ name: 'Profile reader', lifetimeDays: 91 });
    await store.submit();
    expect(api.createToken).not.toHaveBeenCalled();
    store.form.controls.lifetimeDays.setValue(7);
    api.createToken.mockRejectedValueOnce(new IdentityRequestError(0));
    api.createToken.mockResolvedValueOnce({ ...token, token: 'B'.repeat(43) });
    await store.submit();
    vi.advanceTimersByTime(5000);
    await store.submit();
    expect(api.createToken.mock.calls.at(0)).toEqual(api.createToken.mock.calls.at(1));
    const body = api.createToken.mock.calls.at(0)?.at(0);
    expect(body).toMatchObject({
      name: 'Profile reader',
      password,
      scopes: [{ permission: 'profile.read' }],
    });
    expect(store.credential()?.token).toBe('B'.repeat(43));
    expect(store.form.controls.password.value).toBe('');
    expect(JSON.stringify(store)).not.toContain('BBBB');
    expect(JSON.stringify(store.items())).not.toContain('BBBB');
    vi.advanceTimersByTime(600000);
    expect(store.credential()).toBeNull();
  });
  it('requires current MFA proof when enabled and never sends both proof types', async () => {
    api.mfaStatus.mockResolvedValue({
      enabled: true,
      pendingExpiresAt: null,
      recoveryCodesRemaining: 10,
    });
    await store.refresh();
    store.beginCreate();
    store.form.patchValue({ name: 'Profile reader', password });
    await store.submit();
    expect(api.createToken).not.toHaveBeenCalled();
    api.createToken.mockResolvedValue({ ...token, token: 'B'.repeat(43) });
    store.form.controls.factorKind.setValue('recovery');
    store.form.controls.factor.setValue('a'.repeat(32));
    await store.submit();
    expect(api.createToken.mock.calls.at(0)?.at(0)).toMatchObject({ recovery: 'a'.repeat(32) });
    expect(api.createToken.mock.calls.at(0)?.at(0)).not.toHaveProperty('totp');
  });
  it('revokes only a selected active token and refreshes metadata after confirmation', async () => {
    await store.refresh();
    expect(store.beginRevoke('unknown')).toBe(false);
    expect(store.beginRevoke(token.id)).toBe(true);
    store.form.controls.password.setValue(password);
    await store.submit();
    expect(api.revokeToken).toHaveBeenCalledWith(token.id, { password }, expect.any(String));
    expect(store.notice()).toContain('revoked');
    expect(store.selected()).toBeNull();
    expect(api.listTokens).toHaveBeenCalledTimes(2);
  });
  it('does not mistake a failed load for an empty list or an expired session for a valid account', async () => {
    api.listTokens.mockRejectedValueOnce(new IdentityRequestError(503));
    await store.refresh();
    expect(store.state()).toBe('unavailable');
    expect(store.beginCreate()).toBe(false);
    const session = TestBed.inject(SessionStore);
    session.accept({
      userId: 'fixture',
      email: 'person@example.com',
      expiresAt: '2030-01-01T00:00:00Z',
    });
    api.listTokens.mockRejectedValueOnce(new IdentityRequestError(401));
    await store.refresh();
    expect(session.profile()).toBeNull();
  });
  it('invalidates a displayed token on session rotation and ignores late reads', async () => {
    await store.refresh();
    store.beginCreate();
    api.createToken.mockResolvedValue({ ...token, token: 'B'.repeat(43) });
    store.form.patchValue({ name: token.name, password });
    await store.submit();
    let finish: ((value: IdentitySchema<'ApiTokenPageDto'>) => void) | undefined;
    api.listTokens.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = store.refresh();
    store.resetForSession();
    expect(store.credential()).toBeNull();
    api.listTokens.mockResolvedValueOnce({ items: [], nextCursor: null });
    await store.refresh();
    finish?.({ items: [token], nextCursor: null });
    await pending;
    expect(store.items()).toEqual([]);
  });
  it('releases private fields on destruction while sharing the account submission gate', async () => {
    await store.refresh();
    store.beginCreate();
    store.form.patchValue({ name: token.name, password });
    let finish: ((value: IdentitySchema<'ApiTokenCreatedDto'>) => void) | undefined;
    api.createToken.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = store.submit();
    expect(store.beginRevoke(token.id)).toBe(false);
    store.dismiss();
    expect(store.form.controls.password.value).toBe(password);
    TestBed.resetTestingModule();
    finish?.({ ...token, token: 'B'.repeat(43) });
    await pending;
    expect(store.credential()).toBeNull();
    expect(store.form.controls.password.value).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('updates expired status without a network request and stops offering revocation', async () => {
    const expiring = { ...token, expiresAt: new Date(Date.now() + 1000).toISOString() };
    api.listTokens.mockResolvedValueOnce({ items: [expiring], nextCursor: null });
    await store.refresh();
    expect(store.statusFor(expiring)).toBe('active');
    vi.advanceTimersByTime(30000);
    expect(store.statusFor(expiring)).toBe('expired');
    expect(store.beginRevoke(expiring.id)).toBe(false);
    expect(api.listTokens).toHaveBeenCalledTimes(1);
  });
});
