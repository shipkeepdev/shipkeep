import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, Validators } from '@angular/forms';

import { passwordValidator } from './auth-form-store';
import { IdentityApi, IdentityRequestError, type IdentitySchema } from './identity-api';
import { MutationRunner } from './mutation-runner';
import { SessionStore } from './session-store';

type Mode = 'idle' | 'setup' | 'enable' | 'disable' | 'recovery';
type Setup = Pick<IdentitySchema<'MfaSetupDto'>, 'secret' | 'expiresAt'>;

@Injectable()
export class MfaFormStore {
  private readonly api = inject(IdentityApi);
  private readonly session = inject(SessionStore);
  readonly submission = inject(MutationRunner);
  private readonly destroyRef = inject(DestroyRef);
  #revision = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #setup = signal<Setup | null>(null);
  #recovery = signal<readonly string[]>([]);
  readonly setup = this.#setup.asReadonly();
  readonly recoveryCodes = this.#recovery.asReadonly();
  private readonly currentStatus = signal<IdentitySchema<'MfaStatusDto'> | null>(null);
  private readonly loadState = signal<'loading' | 'ready' | 'unavailable'>('loading');
  private readonly currentMode = signal<Mode>('idle');
  private readonly message = signal<string | null>(null);
  private readonly validation = signal<string | null>(null);
  readonly status = this.currentStatus.asReadonly();
  readonly state = this.loadState.asReadonly();
  readonly mode = this.currentMode.asReadonly();
  readonly notice = this.message.asReadonly();
  readonly problem = this.validation.asReadonly();
  readonly form = new FormGroup({
    password: new FormControl('', { nonNullable: true, validators: [passwordValidator] }),
    factor: new FormControl('', { nonNullable: true }),
    factorKind: new FormControl<'totp' | 'recovery'>('totp', { nonNullable: true }),
  });

  constructor() {
    this.form.controls.factorKind.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.form.controls.factor.reset('', { emitEvent: false });
      this.configureProof();
    });
    this.destroyRef.onDestroy(() => {
      ++this.#revision;
      this.clearPrivate();
      this.submission.reset();
    });
  }

  toJSON(): string {
    return '[MfaFormStore]';
  }

  async load(): Promise<void> {
    const revision = ++this.#revision;
    this.loadState.set('loading');
    try {
      const status = await this.api.mfaStatus();
      if (this.destroyRef.destroyed || revision !== this.#revision) return;
      this.currentStatus.set(status);
      this.loadState.set('ready');
    } catch (error: unknown) {
      if (this.destroyRef.destroyed || revision !== this.#revision) return;
      this.currentStatus.set(null);
      this.loadState.set('unavailable');
      if (error instanceof IdentityRequestError && error.status === 401) this.session.clear();
    }
  }

  begin(mode: 'setup' | 'disable' | 'recovery'): boolean {
    const status = this.status();
    if (
      this.submission.busy() ||
      this.state() !== 'ready' ||
      !status ||
      (mode === 'setup' ? status.enabled : !status.enabled)
    )
      return false;
    this.clearPrivate();
    this.submission.reset();
    this.currentMode.set(mode);
    this.message.set(null);
    this.validation.set(null);
    this.configureProof();
    return true;
  }

  dismiss(): void {
    if (this.submission.busy()) return;
    this.clearPrivate();
    this.currentMode.set('idle');
    this.validation.set(null);
    this.message.set(null);
    this.submission.reset();
  }

  errorFor(name: 'password' | 'factor'): string | null {
    const control = this.form.controls[name];
    if (!control.enabled || !control.touched || !control.invalid) return null;
    return name === 'password'
      ? 'Enter your current password (15–128 characters).'
      : this.form.controls.factorKind.value === 'totp'
        ? 'Enter the six-digit code from your authenticator.'
        : 'Enter one complete 32-character recovery code.';
  }

  async submit(): Promise<void> {
    const mode = this.mode();
    if (
      mode === 'idle' ||
      this.destroyRef.destroyed ||
      this.submission.busy() ||
      this.submission.cooldown() ||
      this.submission.restartRequired()
    )
      return;
    this.validation.set(null);
    if (mode === 'enable' && !this.setup()) {
      this.validation.set('This setup has expired. Start setup again.');
      return;
    }
    const control = this.form.controls.factor;
    control.setValue(control.value.trim(), { emitEvent: false });
    this.form.markAllAsTouched();
    this.form.updateValueAndValidity({ emitEvent: false });
    if (this.form.invalid) {
      this.validation.set('Check the marked fields before continuing.');
      return;
    }
    const { password, factor, factorKind } = this.form.getRawValue();
    const body = { password, ...(mode === 'setup' ? {} : { [factorKind]: factor }) };
    const result = await this.submission.run({ mode, ...body }, async (key) => {
      if (mode === 'setup')
        return { kind: 'setup' as const, grant: await this.api.setupMfa({ password }, key) };
      if (mode === 'enable')
        return {
          kind: 'recovery' as const,
          grant: await this.api.enableMfa({ password, totp: factor }, key),
        };
      if (mode === 'disable')
        return { kind: 'disabled' as const, grant: await this.api.disableMfa(body, key) };
      return { kind: 'recovery' as const, grant: await this.api.regenerateRecovery(body, key) };
    });
    if (!result.ok) return;
    this.clearPrivate();
    const { value } = result;
    if (value.kind === 'setup') {
      const duration = Math.min(600000, Date.parse(value.grant.expiresAt) - Date.now());
      if (!Number.isFinite(duration) || duration <= 0) {
        this.currentMode.set('idle');
        this.message.set('This setup has expired. Start setup again.');
      } else {
        this.#setup.set({ secret: value.grant.secret, expiresAt: value.grant.expiresAt });
        this.currentMode.set('enable');
        this.configureProof();
        this.expirePrivate(duration, 'This setup has expired. Start setup again.');
      }
    } else {
      this.session.accept(value.grant);
      this.currentMode.set('idle');
      if (value.kind === 'recovery') {
        this.#recovery.set([...value.grant.recoveryCodes]);
        this.message.set(
          mode === 'enable'
            ? 'Two-factor authentication is enabled.'
            : 'Your recovery codes have been replaced.',
        );
        // No timer: the server shows these codes once, so they stay until the user acknowledges
        // them or leaves the page (WCAG 2.2.1, timing adjustable).
      } else this.message.set('Two-factor authentication is disabled.');
    }
    await this.load();
  }

  private configureProof(): void {
    const { factor, factorKind } = this.form.controls;
    if (this.mode() === 'setup') factor.disable({ emitEvent: false });
    else {
      factor.setValidators([
        (control) => Validators.required(control),
        Validators.pattern(factorKind.value === 'totp' ? /^\d{6}$/ : /^[a-f0-9]{32}$/),
      ]);
      factor.enable({ emitEvent: false });
    }
    if (this.mode() === 'enable' || this.mode() === 'setup')
      factorKind.disable({ emitEvent: false });
    else factorKind.enable({ emitEvent: false });
  }
  private clearPrivate(): void {
    clearTimeout(this.#timer);
    this.#setup.set(null);
    this.#recovery.set([]);
    this.form.reset({}, { emitEvent: false });
  }
  private expirePrivate(duration: number, notice: string): void {
    this.#timer = setTimeout(() => {
      // An already-running activation may still succeed. Hide the seed without dropping its result.
      this.#setup.set(null);
      this.#recovery.set([]);
      this.form.reset({}, { emitEvent: false });
      this.message.set(notice);
    }, duration);
  }
}
