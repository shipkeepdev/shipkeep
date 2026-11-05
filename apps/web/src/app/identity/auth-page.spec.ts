import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { appRoutes } from '../app.routes';

import { AuthFormStore } from './auth-form-store';
import { IdentityApi, IdentityRequestError } from './identity-api';
import { SessionStore } from './session-store';

describe('account route presentation', () => {
  const api = {
    login: vi.fn<IdentityApi['login']>(),
    logout: vi.fn<IdentityApi['logout']>(),
    verifyEmail: vi.fn<IdentityApi['verifyEmail']>(),
  };
  let harness: RouterTestingHarness;
  const profile = {
    userId: 'fixture',
    email: 'person@example.com',
    expiresAt: '2030-01-01T00:00:00Z',
  };
  beforeEach(async () => {
    vi.resetAllMocks();
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

  it('renders all six forms with linked field labels, help and specific page titles', async () => {
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
  it('announces invalid fields and expands an invalid second-factor disclosure', async () => {
    await harness.navigateByUrl('/auth/login');
    store().form.patchValue({
      email: 'person@example.com',
      password: 'correct horse browser fixture',
      factor: '123',
    });
    await submit();
    expect(element().querySelector('#factor')?.getAttribute('aria-invalid')).toBe('true');
    expect(element().querySelector('details')?.open).toBe(true);
    expect(element().querySelector('[role="alert"]')?.textContent).toContain('marked fields');
    expect(api.login).not.toHaveBeenCalled();
  });
  it('navigates to the actual account after login and clears the departed form', async () => {
    api.login.mockResolvedValue(profile);
    await harness.navigateByUrl('/auth/login');
    const form = store();
    form.form.patchValue({ email: profile.email, password: 'correct horse browser fixture' });
    await submit();
    expect(TestBed.inject(Router).url).toBe('/account/security');
    expect(element().textContent).toContain(profile.email);
    expect(form.form.controls.password.value).toBe('');
  });
  it('honors public email links and submits their codes without changing the URL', async () => {
    await harness.navigateByUrl('/verify-email');
    expect(TestBed.inject(Router).url).toBe('/auth/verify-email');
    store().form.controls.code.setValue('B'.repeat(43));
    await submit();
    expect(api.verifyEmail).toHaveBeenCalledWith('B'.repeat(43), expect.any(String));
    expect(TestBed.inject(Router).url).toBe('/auth/verify-email');
    expect(element().querySelector('[role="status"]')?.textContent).toContain('verified');
    await harness.navigateByUrl('/reset-password');
    expect(element().querySelector('#confirmation')).not.toBeNull();
  });
  it('keeps a failed sign-out visible and returns to sign-in only on confirmation', async () => {
    TestBed.inject(SessionStore).accept(profile);
    await harness.navigateByUrl('/account/security');
    api.logout.mockRejectedValueOnce(new IdentityRequestError(0));
    element().querySelector('button')?.click();
    await harness.fixture.whenStable();
    expect(element().querySelector('[role="alert"]')?.textContent).toContain('Connection lost');
    expect(element().textContent).toContain(profile.email);
    api.logout.mockResolvedValue();
    element().querySelector('button')?.click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/auth/login');
  });
});
