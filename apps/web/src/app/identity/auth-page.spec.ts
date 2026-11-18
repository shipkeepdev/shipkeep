import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { appRoutes } from '../app.routes';

import { AuthFormStore } from './auth-form-store';
import { AuthOptions } from './auth-options';
import { IdentityApi, IdentityRequestError } from './identity-api';
import { SessionStore } from './session-store';

describe('account route presentation', () => {
  const api = {
    login: vi.fn<IdentityApi['login']>(),
    logout: vi.fn<IdentityApi['logout']>(),
    verifyEmail: vi.fn<IdentityApi['verifyEmail']>(),
    mfaStatus: vi.fn<IdentityApi['mfaStatus']>(),
    listTokens: vi.fn<IdentityApi['listTokens']>(),
    options: vi.fn<IdentityApi['options']>(),
  };
  let harness: RouterTestingHarness;
  const profile = {
    userId: 'fixture',
    email: 'person@example.com',
    expiresAt: '2030-01-01T00:00:00Z',
  };
  beforeEach(async () => {
    vi.resetAllMocks();
    api.listTokens.mockResolvedValue({ items: [], nextCursor: null });
    api.options.mockResolvedValue({ email: true });
    api.mfaStatus.mockResolvedValue({
      enabled: false,
      pendingExpiresAt: null,
      recoveryCodesRemaining: 0,
    });
    TestBed.configureTestingModule({
      providers: [provideRouter(appRoutes), { provide: IdentityApi, useValue: api }],
    });
    harness = await RouterTestingHarness.create();
  });
  function element(): HTMLElement {
    const element = harness.routeNativeElement;
    if (!element) throw new Error('missing route');
    return element;
  }
  function store(): AuthFormStore {
    const store = harness.routeDebugElement?.injector.get(AuthFormStore);
    if (!store) throw new Error('missing form');
    return store;
  }
  async function submit(): Promise<void> {
    element()
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await harness.fixture.whenStable();
  }

  it('renders all six forms with linked field labels, help and page titles', async () => {
    for (const path of [
      'login',
      'register',
      'verify-email',
      'request-verification',
      'forgot-password',
      'reset-password',
    ]) {
      await harness.navigateByUrl(`/auth/${path}`);
      expect(element().querySelectorAll('h1')).toHaveLength(1);
      for (const input of element().querySelectorAll('input, select')) {
        expect(element().querySelector(`label[for="${input.id}"]`)).not.toBeNull();
        for (const id of input.getAttribute('aria-describedby')?.split(' ') ?? [])
          expect(element().querySelector(`#${id}`)).not.toBeNull();
      }
      expect(document.title).toContain('Shipkeep');
    }
  });
  it('announces invalid fields, then offers the second-factor step after a refusal', async () => {
    await harness.navigateByUrl('/auth/login');
    store().form.patchValue({ email: 'not an address', password: 'correct horse browser fixture' });
    await submit();
    expect(element().querySelector('#email')?.getAttribute('aria-invalid')).toBe('true');
    expect(element().querySelector('[role="alert"]')?.textContent).toContain('marked fields');
    expect(api.login).not.toHaveBeenCalled();

    api.login.mockRejectedValueOnce(new IdentityRequestError(401));
    store().form.patchValue({ email: 'person@example.com' });
    await submit();
    expect(element().querySelector('h1')?.textContent).toContain('Two-factor authentication');
    expect(element().querySelector('#password')).toBeNull();
    store().form.controls.factor.setValue('123');
    await submit();
    expect(element().querySelector('#factor')?.getAttribute('aria-invalid')).toBe('true');
    expect(api.login).toHaveBeenCalledTimes(1);
  });
  it('keeps the GitHub and GitLab buttons, which say they are not available yet', async () => {
    await harness.navigateByUrl('/auth/login');
    const buttons = Array.from(element().querySelectorAll('button')).map((b) =>
      b.textContent.trim(),
    );
    expect(buttons).toContain('GitHub');
    expect(buttons).toContain('GitLab');
  });
  it('navigates to the organizations after login and clears the departed form', async () => {
    api.login.mockResolvedValue(profile);
    await harness.navigateByUrl('/auth/login');
    const form = store();
    form.form.patchValue({ email: profile.email, password: 'correct horse browser fixture' });
    await submit();
    expect(TestBed.inject(Router).url).toBe('/home');
    expect(element().querySelector('#password')).toBeNull();
    expect(form.form.controls.password.value).toBe('');
  });
  it('honors public email links and submits their codes without changing the URL', async () => {
    await harness.navigateByUrl('/verify-email');
    expect(TestBed.inject(Router).url).toBe('/auth/verify-email');
    expect(element().querySelector('#password')?.getAttribute('autocomplete')).toBe(
      'current-password',
    );
    expect(element().querySelector('a[href="/auth/forgot-password"]')).not.toBeNull();
    store().form.patchValue({ code: 'B'.repeat(43), password: 'correct horse browser fixture' });
    await submit();
    expect(api.verifyEmail).toHaveBeenCalledWith(
      { token: 'B'.repeat(43), password: 'correct horse browser fixture' },
      expect.any(String),
    );
    expect(TestBed.inject(Router).url).toBe('/auth/verify-email');
    expect(element().querySelector('[role="status"]')?.textContent).toContain('verified');
    await harness.navigateByUrl('/reset-password');
    expect(element().querySelector('#code')).not.toBeNull();
    expect(element().querySelector('#password')?.getAttribute('autocomplete')).toBe('new-password');
  });
  it('keeps a failed sign-out visible and returns to sign-in only on confirmation', async () => {
    TestBed.inject(SessionStore).accept(profile);
    await harness.navigateByUrl('/orgs/00000000-0000-4000-8000-000000000000/profile');
    api.logout.mockRejectedValueOnce(new IdentityRequestError(0));
    Array.from(element().querySelectorAll('button'))
      .find((button) => button.textContent.trim() === 'Sign out')
      ?.click();
    await harness.fixture.whenStable();
    expect(element().querySelector('[role="alert"]')?.textContent).toContain('Connection lost');
    expect(element().textContent).toContain(profile.email);
    api.logout.mockResolvedValue();
    Array.from(element().querySelectorAll('button'))
      .find((button) => button.textContent.trim() === 'Sign out')
      ?.click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/auth/login');
  });
  describe('on an installation that sends no email (ADR 0020)', () => {
    const links = () =>
      [...element().querySelectorAll('a')].map((link) => link.getAttribute('href') ?? '');
    const text = () => element().textContent.replace(/\s+/g, ' ');

    it('signs in as usual, and says who creates accounts and resets passwords', async () => {
      api.options.mockResolvedValue({ email: false });
      await harness.navigateByUrl('/auth/login');
      await harness.fixture.whenStable();
      expect(element().querySelector('form')).not.toBeNull();
      expect(element().querySelector('#email')).not.toBeNull();
      expect(element().querySelector('#password')).not.toBeNull();
      // Neither of these could ever work here: they are not offered.
      expect(links()).not.toContain('/auth/register');
      expect(links()).not.toContain('/auth/forgot-password');
      expect(text()).toContain(
        'No account, or a lost password? Ask the administrator of this installation.',
      );
    });

    it('explains, instead of a form that cannot work, on every screen that sends a message', async () => {
      api.options.mockResolvedValue({ email: false });
      for (const path of ['register', 'forgot-password', 'request-verification']) {
        await harness.navigateByUrl(`/auth/${path}`);
        await harness.fixture.whenStable();
        expect(element().querySelector('form'), path).toBeNull();
        expect(element().querySelector('h1')?.textContent, path).toContain(
          'This installation sends no email',
        );
        expect(text(), path).toContain(
          'Its administrator creates accounts and resets passwords, on the server that runs Shipkeep.',
        );
        expect(links(), path).toContain('/auth/login');
        expect(links(), path).not.toContain('/auth/register');
      }
    });

    it('keeps the screens that redeem a code: a code sent before still works', async () => {
      api.options.mockResolvedValue({ email: false });
      for (const path of ['verify-email', 'reset-password']) {
        await harness.navigateByUrl(`/auth/${path}`);
        await harness.fixture.whenStable();
        expect(element().querySelector('form'), path).not.toBeNull();
        expect(element().querySelector('#code'), path).not.toBeNull();
        expect(text(), path).not.toContain('This installation sends no email');
        // No way to ask for another message, and none to the reset either.
        expect(links(), path).not.toContain('/auth/request-verification');
        expect(links(), path).not.toContain('/auth/forgot-password');
        expect(links(), path).toContain('/auth/login');
      }
    });

    async function offersEverything(): Promise<void> {
      await harness.navigateByUrl('/auth/login');
      await harness.fixture.whenStable();
      expect(api.options).toHaveBeenCalled();
      expect(links()).toContain('/auth/register');
      expect(links()).toContain('/auth/forgot-password');
      await harness.navigateByUrl('/auth/register');
      await harness.fixture.whenStable();
      expect(element().querySelector('form')).not.toBeNull();
      expect(text()).not.toContain('This installation sends no email');
    }

    it('offers everything when the installation sends email', async () => {
      api.options.mockResolvedValue({ email: true });
      await offersEverything();
    });

    it('offers everything when the first question gets no answer', async () => {
      // A fresh application: no earlier answer can stand in for this one.
      api.options.mockRejectedValue(new IdentityRequestError(0));
      await offersEverything();
    });

    it('moves focus to the explanation when a late answer removes the form in use', async () => {
      api.options.mockResolvedValue({ email: true });
      await harness.navigateByUrl('/auth/register');
      await harness.fixture.whenStable();
      const field = element().querySelector<HTMLInputElement>('#email');
      if (!field) throw new Error('missing field');
      field.focus();
      expect(document.activeElement).toBe(field);
      api.options.mockResolvedValue({ email: false });
      await TestBed.inject(AuthOptions).refresh();
      await vi.waitFor(async () => {
        await harness.fixture.whenStable();
        expect(element().querySelector('form')).toBeNull();
      });
      expect(document.activeElement).toBe(element().querySelector('h1'));
    });

    it('leaves focus alone when it was not in the form that went away', async () => {
      api.options.mockResolvedValue({ email: true });
      await harness.navigateByUrl('/auth/register');
      await harness.fixture.whenStable();
      const language = [...element().querySelectorAll('button')].find(
        (button) => button.textContent.trim() === 'FR',
      );
      if (!language) throw new Error('missing language button');
      language.focus();
      api.options.mockResolvedValue({ email: false });
      await TestBed.inject(AuthOptions).refresh();
      await vi.waitFor(async () => {
        await harness.fixture.whenStable();
        expect(element().querySelector('form')).toBeNull();
      });
      expect(document.activeElement).toBe(language);
    });

    it('says the same when the server refuses a request for that reason', () => {
      // Seen when the screens could not ask first: the refusal is not a conflict to "start again".
      expect(new IdentityRequestError(409, 0, { code: 'email_not_configured' }).message).toBe(
        'This installation sends no email: its administrator creates accounts and resets passwords.',
      );
      expect(new IdentityRequestError(409, 0, { code: 'slug_taken' }).message).toContain(
        'conflicts with the current account state',
      );
    });
  });
});
