import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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

/** The route provides this store and its runner; no password or code survives that route. */
@Injectable()
export class AuthFormStore {
  private readonly api = inject(IdentityApi);
  private readonly session = inject(SessionStore);
  readonly submission = inject(MutationRunner);
  private readonly currentMode = signal<AuthMode>('login');
  readonly mode = this.currentMode.asReadonly();
  readonly hasEmail = computed(() =>
    ['login', 'register', 'request-verification', 'forgot-password'].includes(this.mode()),
  );
  readonly hasPassword = computed(() =>
    ['login', 'register', 'verify-email', 'reset-password'].includes(this.mode()),
  );
  readonly hasConfirmation = computed(() => ['register', 'reset-password'].includes(this.mode()));
  readonly hasCode = computed(() => ['verify-email', 'reset-password'].includes(this.mode()));
  private readonly message = signal<string | null>(null);
  private readonly invalid = signal<string | null>(null);
  readonly success = this.message.asReadonly();
  readonly validationProblem = this.invalid.asReadonly();
  readonly form = new FormGroup({
    email: field(),
    password: field(),
    confirmation: field(),
    code: field(),
    factor: field(),
    factorKind: new FormControl<'totp' | 'recovery'>('totp', { nonNullable: true }),
  });

  constructor() {
    this.form.setValidators(() =>
      this.form.controls.confirmation.enabled &&
      this.form.controls.confirmation.value !== this.form.controls.password.value
        ? { mismatch: true }
        : null,
    );
    this.form.controls.factorKind.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.form.controls.factor.reset('', { emitEvent: false });
      this.configureFactor();
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
    this.currentMode.set(mode);
    this.message.set(null);
    this.invalid.set(null);
    const controls = this.form.controls;
    this.configureField('email', this.hasEmail(), [required, emailValidator]);
    this.configureField('password', this.hasPassword(), [passwordValidator]);
    this.configureField('confirmation', this.hasConfirmation(), [required]);
    this.configureField('code', this.hasCode(), [required, codeValidator]);
    this.configureField('factor', mode === 'login', []);
    if (mode === 'login') controls.factorKind.enable({ emitEvent: false });
    else controls.factorKind.disable({ emitEvent: false });
    this.configureFactor();
    this.form.updateValueAndValidity({ emitEvent: false });
  }

  restart(): void {
    this.configure(this.mode());
  }

  errorFor(name: 'email' | 'password' | 'confirmation' | 'code' | 'factor'): string | null {
    const control = this.form.controls[name];
    if (!control.enabled || !control.touched) return null;
    if (name === 'confirmation' && this.form.hasError('mismatch')) return 'Passwords must match.';
    if (!control.invalid) return null;
    const messages = {
      email: 'Enter a valid email address.',
      password: 'Use 15–128 characters and remove unsupported characters.',
      confirmation: 'Enter your password again.',
      code: 'Paste the complete 43-character code from your email.',
      factor:
        this.form.controls.factorKind.value === 'totp'
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
    controls.factor.setValue(controls.factor.value.trim(), { emitEvent: false });
    this.form.markAllAsTouched();
    this.form.updateValueAndValidity({ emitEvent: false });
    if (this.form.invalid) {
      this.invalid.set('Check the marked fields before continuing.');
      return null;
    }
    const mode = this.mode();
    const { email, password, code: token, factor, factorKind } = this.form.getRawValue();
    const body =
      mode === 'login'
        ? { email, password, ...(factor ? { [factorKind]: factor } : {}) }
        : mode === 'register'
          ? { email, password }
          : mode === 'reset-password'
            ? { token, password }
            : mode === 'verify-email'
              ? { token, password }
              : { email };
    const result = await this.submission.run(body, (key) => {
      switch (mode) {
        case 'login':
          return this.session.login(
            { email, password, ...(factor ? { [factorKind]: factor } : {}) },
            key,
          );
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
    if (!result.ok) return null;
    for (const name of ['password', 'confirmation', 'code', 'factor'] as const)
      controls[name].reset('', { emitEvent: false });
    if (mode === 'login') return '/home';
    if (mode === 'reset-password') this.session.clear();
    this.message.set(
      mode === 'verify-email'
        ? 'Your email address is verified. You can sign in.'
        : mode === 'reset-password'
          ? 'Your password has been updated. Sign in with your new password.'
          : 'If this address can receive the requested email, it will arrive shortly. Check your inbox and spam folder.',
    );
    return null;
  }

  private configureField(
    name: 'email' | 'password' | 'confirmation' | 'code' | 'factor',
    active: boolean,
    validators: ValidatorFn[],
  ): void {
    const control = this.form.controls[name];
    control.setValidators(validators);
    if (active) control.enable({ emitEvent: false });
    else control.disable({ emitEvent: false });
  }
  private configureFactor(): void {
    const control = this.form.controls.factor;
    control.setValidators(
      Validators.pattern(
        this.form.controls.factorKind.value === 'totp' ? /^\d{6}$/ : /^[a-f0-9]{32}$/,
      ),
    );
    control.updateValueAndValidity({ emitEvent: false });
  }
}
