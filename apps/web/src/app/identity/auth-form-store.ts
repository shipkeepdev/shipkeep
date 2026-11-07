import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { FormControl, FormGroup, Validators, type ValidatorFn } from '@angular/forms';

import { IdentityApi } from './identity-api';
import { MutationRunner } from './mutation-runner';
import { SessionStore } from './session-store';

export const AUTH_MODES = [
  'login',
  'register',
  'verify-email',
  'request-verification',
  'forgot-password',
  'reset-password',
] as const;
export type AuthMode = (typeof AUTH_MODES)[number];
export function isAuthMode(value: unknown): value is AuthMode {
  return typeof value === 'string' && AUTH_MODES.some((mode) => mode === value);
}
/** Sign-in happens in up to two screens: the password, then a second factor when it is on. */
export type LoginStep = 'password' | 'totp' | 'recovery';
export type AuthField = 'name' | 'email' | 'password' | 'code' | 'factor';

export const passwordValidator: ValidatorFn = (control) => {
  const value: unknown = control.value;
  if (typeof value !== 'string') return { password: true };
  const length = Array.from(value).length;
  return length >= 15 && length <= 128 && !value.includes(String.fromCharCode(0))
    ? null
    : { password: true };
};
const emailValidator: ValidatorFn = (control) => {
  const value: unknown = control.value;
  return typeof value === 'string' &&
    value.length <= 254 &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 33 || character.charCodeAt(0) > 126,
    ) &&
    value.split('@').at(1)?.includes('.') &&
    !Validators.email(control)
    ? null
    : { email: true };
};
const codeValidator = Validators.pattern(/^[A-Za-z0-9_-]{43}$/);
const required: ValidatorFn = (control) => Validators.required(control);
const field = () => new FormControl('', { nonNullable: true });

/** 0 to 4 bars for the strength meter, after the API's rule of 15 to 128 characters. */
export function passwordScore(password: string): number {
  if (!password) return 0;
  const length = Array.from(password).length;
  return Math.min(
    4,
    Number(length >= 15) +
      Number(length >= 20) +
      Number(/[A-Z]/.test(password) && /[a-z]/.test(password)) +
      Number(/[0-9\W]/.test(password)),
  );
}

/**
 * The email address typed on one account screen, offered on the next one (sign-up, then the
 * verification code; forgotten password, then the reset code). Never a password or a code.
 */
@Injectable({ providedIn: 'root' })
export class AuthHandoff {
  readonly email = signal('');
}

/** The route provides this store and its runner; no password or code survives that route. */
@Injectable()
export class AuthFormStore {
  private readonly api = inject(IdentityApi);
  private readonly session = inject(SessionStore);
  private readonly handoff = inject(AuthHandoff);
  readonly submission = inject(MutationRunner);
  private readonly currentMode = signal<AuthMode>('login');
  private readonly currentStep = signal<LoginStep>('password');
  readonly mode = this.currentMode.asReadonly();
  readonly step = this.currentStep.asReadonly();
  readonly hasName = computed(() => this.mode() === 'register');
  readonly hasEmail = computed(
    () =>
      ['register', 'request-verification', 'forgot-password'].includes(this.mode()) ||
      (this.mode() === 'login' && this.step() === 'password'),
  );
  readonly hasPassword = computed(
    () =>
      ['register', 'verify-email', 'reset-password'].includes(this.mode()) ||
      (this.mode() === 'login' && this.step() === 'password'),
  );
  readonly hasCode = computed(() => ['verify-email', 'reset-password'].includes(this.mode()));
  readonly hasFactor = computed(() => this.mode() === 'login' && this.step() !== 'password');
  /** The address the last code was sent to, when this browser asked for it. */
  readonly sentTo = computed(() => this.handoff.email());
  private readonly message = signal<string | null>(null);
  private readonly invalid = signal<string | null>(null);
  readonly success = this.message.asReadonly();
  readonly validationProblem = this.invalid.asReadonly();
  readonly form = new FormGroup({
    name: field(),
    email: field(),
    password: field(),
    code: field(),
    factor: field(),
  });
  /** Mirrors of two inputs, for the strength meter and the six code boxes. */
  readonly password = signal('');
  readonly factor = signal('');

  constructor() {
    this.form.controls.password.valueChanges.subscribe((value) => {
      this.password.set(value);
    });
    this.form.controls.factor.valueChanges.subscribe((value) => {
      this.factor.set(value);
    });
    inject(DestroyRef).onDestroy(() => {
      this.form.reset({}, { emitEvent: false });
      this.submission.reset();
    });
    this.configure('login');
  }

  configure(mode: AuthMode): void {
    this.submission.reset();
    this.form.reset({}, { emitEvent: false });
    this.password.set('');
    this.factor.set('');
    this.currentMode.set(mode);
    this.currentStep.set('password');
    this.message.set(null);
    this.invalid.set(null);
    if (
      ['verify-email', 'reset-password', 'request-verification', 'forgot-password'].includes(mode)
    )
      this.form.controls.email.setValue(this.handoff.email(), { emitEvent: false });
    this.applyFields();
  }

  /** Between the password and the second-factor screens of sign-in. */
  goTo(step: LoginStep): void {
    this.submission.reset();
    this.invalid.set(null);
    this.form.controls.factor.reset('', { emitEvent: false });
    this.factor.set('');
    this.currentStep.set(step);
    this.applyFields();
  }

  restart(): void {
    this.configure(this.mode());
  }

  errorFor(name: AuthField): string | null {
    const control = this.form.controls[name];
    if (!control.enabled || !control.touched || !control.invalid) return null;
    const messages: Record<AuthField, string> = {
      name: 'Enter your name.',
      email: 'Enter a valid email address.',
      password: 'Use 15–128 characters and remove unsupported characters.',
      code: 'Paste the complete 43-character code from your email.',
      factor:
        this.step() === 'totp'
          ? 'Enter the six-digit code from your authenticator.'
          : 'Enter one complete 32-character recovery code.',
    };
    return messages[name];
  }

  async submit(): Promise<string | null> {
    if (
      this.submission.busy() ||
      this.submission.cooldown() ||
      this.submission.restartRequired() ||
      this.success()
    )
      return null;
    this.invalid.set(null);
    const controls = this.form.controls;
    controls.email.setValue(controls.email.value.trim().toLowerCase(), { emitEvent: false });
    controls.code.setValue(controls.code.value.trim(), { emitEvent: false });
    controls.factor.setValue(controls.factor.value.trim().toLowerCase(), { emitEvent: false });
    this.form.markAllAsTouched();
    this.form.updateValueAndValidity({ emitEvent: false });
    if (this.form.invalid) {
      this.invalid.set('Check the marked fields before continuing.');
      return null;
    }
    const mode = this.mode();
    const step = this.step();
    const { email, password, code: token, factor } = this.form.getRawValue();
    const proof =
      step === 'totp' ? { totp: factor } : step === 'recovery' ? { recovery: factor } : {};
    const body =
      mode === 'login'
        ? { email, password, ...proof }
        : mode === 'register'
          ? { email, password }
          : mode === 'reset-password' || mode === 'verify-email'
            ? { token, password }
            : { email };
    const result = await this.submission.run(body, (key) => {
      switch (mode) {
        case 'login':
          return this.session.login({ email, password, ...proof }, key);
        case 'register':
          return this.api.register({ email, password }, key);
        case 'verify-email':
          return this.api.verifyEmail({ token, password }, key);
        case 'request-verification':
          return this.api.requestVerification(email, key);
        case 'forgot-password':
          return this.api.requestPasswordReset(email, key);
        case 'reset-password':
          return this.api.resetPassword({ token, password }, key);
      }
    });
    if (!result.ok) {
      // The API answers a missing second factor like a wrong password, so as not to tell an
      // attacker which passwords are right. Offer the code screen; it explains both causes.
      if (mode === 'login' && step === 'password' && this.submission.status() === 401) {
        this.submission.reset();
        this.goTo('totp');
        return 'step';
      }
      return null;
    }
    for (const name of ['password', 'code', 'factor'] as const)
      controls[name].reset('', { emitEvent: false });
    this.password.set('');
    this.factor.set('');
    if (mode === 'login') {
      controls.email.reset('', { emitEvent: false });
      return '/home';
    }
    if (mode !== 'verify-email') this.handoff.email.set(email);
    if (mode === 'forgot-password') return '/auth/reset-password';
    if (mode === 'request-verification') return '/auth/verify-email';
    if (mode === 'reset-password') {
      this.session.clear();
      this.handoff.email.set('');
    }
    this.message.set(
      mode === 'verify-email'
        ? 'Your email address is verified. You can sign in.'
        : mode === 'reset-password'
          ? 'Your password has been updated. Sign in with your new password.'
          : 'If this address can receive email, a verification code is on its way. Check your inbox and spam folder.',
    );
    return null;
  }

  private applyFields(): void {
    const set = (name: AuthField, active: boolean, validators: ValidatorFn[]) => {
      const control = this.form.controls[name];
      control.setValidators(validators);
      if (active) control.enable({ emitEvent: false });
      else control.disable({ emitEvent: false });
    };
    set('name', this.hasName(), []);
    set('email', this.hasEmail(), [required, emailValidator]);
    set('password', this.hasPassword(), [passwordValidator]);
    set('code', this.hasCode(), [required, codeValidator]);
    set('factor', this.hasFactor(), [
      required,
      Validators.pattern(this.step() === 'totp' ? /^\d{6}$/ : /^[a-f0-9]{32}$/),
    ]);
    this.form.updateValueAndValidity({ emitEvent: false });
  }
}
