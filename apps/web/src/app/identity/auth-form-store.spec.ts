import { TestBed } from '@angular/core/testing';

import { AuthFormStore, AuthHandoff, passwordScore } from './auth-form-store';
import { IdentityApi, IdentityRequestError } from './identity-api';
import { MutationRunner } from './mutation-runner';
import { SessionStore } from './session-store';

describe('account forms', () => {
  const password = '  fifteen unicode characters 🔒  ';
  const token = 'B'.repeat(43);
  const api = {
    register: vi.fn<IdentityApi['register']>(),
    verifyEmail: vi.fn<IdentityApi['verifyEmail']>(),
    requestVerification: vi.fn<IdentityApi['requestVerification']>(),
    requestPasswordReset: vi.fn<IdentityApi['requestPasswordReset']>(),
    resetPassword: vi.fn<IdentityApi['resetPassword']>(),
  };
  const session = { login: vi.fn<SessionStore['login']>(), clear: vi.fn() };
  let store: AuthFormStore;
  beforeEach(() => {
    vi.resetAllMocks();
    TestBed.configureTestingModule({
      providers: [
        AuthFormStore,
        MutationRunner,
        { provide: IdentityApi, useValue: api },
        { provide: SessionStore, useValue: session },
      ],
    });
    store = TestBed.inject(AuthFormStore);
  });

  it('requires valid active fields without sending a request', async () => {
    store.configure('register');
    expect(await store.submit()).toBeNull();
    expect(store.form.controls.email.touched).toBe(true);
    expect(store.errorFor('email')).toContain('valid email');
    expect(store.errorFor('password')).toContain('15–128');
    expect(api.register).not.toHaveBeenCalled();
    expect(store.validationProblem()).toBeTruthy();
  });

  it('scores passwords for the strength meter after the API rule', () => {
    expect(passwordScore('')).toBe(0);
    expect(passwordScore('short')).toBe(0);
    expect(passwordScore('a'.repeat(15))).toBe(1);
    expect(passwordScore('Correct Horse Battery 9')).toBe(4);
  });

  it('normalizes the mailbox but preserves password whitespace and clears private inputs', async () => {
    store.configure('register');
    store.form.patchValue({ name: 'Ada', email: ' Person@Example.com ', password });
    await store.submit();
    // The name is not stored by the API yet, so it is not sent.
    expect(api.register).toHaveBeenCalledWith(
      { email: 'person@example.com', password },
      expect.any(String),
    );
    expect(store.success()).toContain('If this address can receive');
    expect(store.form.controls.password.value).toBe('');
    expect(store.password()).toBe('');
  });

  it('counts password Unicode code points and rejects NUL without trimming', async () => {
    store.configure('register');
    const form = store.form;
    for (const invalid of [
      '🔒'.repeat(14),
      'a'.repeat(129),
      `fifteen characters${String.fromCharCode(0)}`,
    ]) {
      form.patchValue({ email: 'person@example.com', password: invalid });
      await store.submit();
    }
    expect(api.register).not.toHaveBeenCalled();
    form.patchValue({ password: '🔒'.repeat(15) });
    await store.submit();
    expect(api.register).toHaveBeenCalledTimes(1);
  });

  it('asks for a second factor after a refused password, then sends one proof only', async () => {
    store.form.patchValue({ email: 'person@example.com', password });
    session.login.mockRejectedValueOnce(new IdentityRequestError(401));
    expect(await store.submit()).toBe('step');
    expect(session.login).toHaveBeenLastCalledWith(
      { email: 'person@example.com', password },
      expect.any(String),
    );
    expect(store.step()).toBe('totp');
    expect(store.submission.problem()).toBeNull();
    store.form.controls.factor.setValue('123');
    expect(await store.submit()).toBeNull();
    expect(session.login).toHaveBeenCalledTimes(1);
    store.form.controls.factor.setValue(' 123456 ');
    expect(await store.submit()).toBe('/home');
    expect(session.login).toHaveBeenLastCalledWith(
      { email: 'person@example.com', password, totp: '123456' },
      expect.any(String),
    );
    expect(store.form.controls.password.value).toBe('');

    store.configure('login');
    store.form.patchValue({ email: 'person@example.com', password });
    session.login.mockRejectedValueOnce(new IdentityRequestError(401));
    await store.submit();
    store.goTo('recovery');
    store.form.controls.factor.setValue('A'.repeat(32));
    await store.submit();
    expect(session.login).toHaveBeenLastCalledWith(
      { email: 'person@example.com', password, recovery: 'a'.repeat(32) },
      expect.any(String),
    );
  });

  it('stays on the password step when the refusal is not a credentials one', async () => {
    store.form.patchValue({ email: 'person@example.com', password });
    session.login.mockRejectedValueOnce(new IdentityRequestError(429, 30));
    expect(await store.submit()).toBeNull();
    expect(store.step()).toBe('password');
    expect(store.submission.problem()).toContain('Too many attempts');
  });

  it('supports both mail requests and keeps their outcomes non-enumerating', async () => {
    for (const mode of ['request-verification', 'forgot-password'] as const) {
      store.configure(mode);
      store.form.controls.email.setValue('person@example.com');
      expect(await store.submit()).toBe(
        mode === 'forgot-password' ? '/auth/reset-password' : '/auth/verify-email',
      );
      // The next screen asks for the code; the address is offered there, never a secret.
      expect(TestBed.inject(AuthHandoff).email()).toBe('person@example.com');
      expect(store.form.controls.password.disabled).toBe(true);
    }
    expect(api.requestVerification).toHaveBeenCalledWith('person@example.com', expect.any(String));
    expect(api.requestPasswordReset).toHaveBeenCalledWith('person@example.com', expect.any(String));
  });

  it('submits codes in bodies and clears the current session only after a confirmed reset', async () => {
    store.configure('verify-email');
    store.form.controls.code.setValue(` ${token} `);
    await store.submit();
    // The registration password is required: a mailbox link alone cannot activate an account.
    expect(api.verifyEmail).not.toHaveBeenCalled();
    store.form.controls.password.setValue(password);
    await store.submit();
    expect(api.verifyEmail).toHaveBeenCalledWith({ token, password }, expect.any(String));
    expect(store.form.controls.password.value).toBe('');
    store.configure('reset-password');
    expect(store.sentTo()).toBe('');
    store.form.patchValue({ code: token, password });
    api.resetPassword.mockRejectedValueOnce(new IdentityRequestError(0));
    await store.submit();
    expect(session.clear).not.toHaveBeenCalled();
    expect(store.form.controls.password.value).toBe(password);
    await store.submit();
    expect(api.resetPassword).toHaveBeenCalledWith({ token, password }, expect.any(String));
    expect(session.clear).toHaveBeenCalledTimes(1);
    expect(store.form.controls.code.value).toBe('');
  });

  it('clears credentials on route changes/destruction and ignores stale success', async () => {
    let finish: (() => void) | undefined;
    api.register.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    store.configure('register');
    store.form.patchValue({ email: 'person@example.com', password });
    const pending = store.submit();
    store.configure('login');
    finish?.();
    expect(await pending).toBeNull();
    expect(store.success()).toBeNull();
    expect(store.form.controls.password.value).toBe('');
    store.form.controls.password.setValue(password);
    TestBed.resetTestingModule();
    expect(store.form.controls.password.value).toBe('');
  });
});
