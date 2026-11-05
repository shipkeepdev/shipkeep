import { TestBed } from '@angular/core/testing';

import { IdentityApi, IdentityRequestError } from './identity-api';
import { SessionStore } from './session-store';

describe('session state', () => {
  const profile = {
    userId: 'fixture',
    email: 'person@example.com',
    expiresAt: '2030-01-01T00:00:00Z',
  };
  const api = {
    session: vi.fn<IdentityApi['session']>(),
    login: vi.fn<IdentityApi['login']>(),
    logout: vi.fn<IdentityApi['logout']>(),
  };
  let store: SessionStore;
  beforeEach(() => {
    vi.resetAllMocks();
    TestBed.configureTestingModule({ providers: [{ provide: IdentityApi, useValue: api }] });
    store = TestBed.inject(SessionStore);
  });
  it('distinguishes expired credentials from an unavailable service', async () => {
    api.session.mockRejectedValue(new IdentityRequestError(401));
    await store.refresh();
    expect(store.state()).toBe('anonymous');
    api.session.mockRejectedValue(new IdentityRequestError(503));
    await store.refresh();
    expect(store.state()).toBe('unavailable');
  });

  it('accepts a server-confirmed session and preserves it when a new login fails', async () => {
    api.session.mockResolvedValue(profile);
    await store.refresh();
    expect(store.state()).toBe('authenticated');
    const credentials = { email: profile.email, password: 'correct horse browser fixture' };
    api.login.mockRejectedValue(new IdentityRequestError(401));
    await expect(store.login(credentials, 'request-key')).rejects.toThrow('could not be verified');
    expect(store.profile()).toEqual(profile);
    api.login.mockResolvedValue({ ...profile, expiresAt: '2030-01-02T00:00:00Z' });
    await store.login(credentials, 'new-request-key');
    expect(store.profile()?.expiresAt).toBe('2030-01-02T00:00:00Z');
  });
  it('prevents a late session check from restoring a signed-out session', async () => {
    let resolve: ((value: typeof profile) => void) | undefined;
    api.session.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const loading = store.refresh();
    api.logout.mockResolvedValue();
    await store.logout('request-key');
    resolve?.(profile);
    await loading;
    expect(store.state()).toBe('anonymous');
    expect(store.profile()).toBeNull();
  });
  it('keeps private MFA/token grants out of the session and does not pretend a failed logout succeeded', async () => {
    const grant = { ...profile, token: 'private fixture', recoveryCodes: ['private fixture'] };
    store.accept(grant);
    expect(store.profile()).toEqual(profile);
    api.logout.mockRejectedValue(new IdentityRequestError(0));
    await expect(store.logout('request-key')).rejects.toThrow('Connection lost.');
    expect(store.state()).toBe('authenticated');
  });
  it('treats a 401 logout as already signed out', async () => {
    store.accept(profile);
    api.logout.mockRejectedValue(new IdentityRequestError(401));
    await store.logout('request-key');
    expect(store.state()).toBe('anonymous');
    expect(store.profile()).toBeNull();
  });

  it('settles a pending session check when a superseding login fails', async () => {
    let resolve: ((value: typeof profile) => void) | undefined;
    api.session.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const loading = store.refresh();
    api.session.mockRejectedValueOnce(new IdentityRequestError(401));
    api.login.mockRejectedValue(new IdentityRequestError(401));
    await expect(
      store.login({ email: profile.email, password: 'correct horse browser fixture' }, 'key'),
    ).rejects.toThrow('could not be verified');
    resolve?.(profile);
    await loading;
    await vi.waitFor(() => {
      expect(store.state()).toBe('anonymous');
    });
  });
});
