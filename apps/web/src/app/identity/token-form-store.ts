import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, Validators, type ValidatorFn } from '@angular/forms';

import { PROFILE_ONLY, type TokenGrant } from '../access/token-scope-picker';

import { passwordValidator } from './auth-form-store';
import { IdentityApi, IdentityRequestError, type IdentitySchema } from './identity-api';
import { MutationRunner } from './mutation-runner';
import { SessionStore } from './session-store';

type Token = IdentitySchema<'ApiTokenDto'>;
type Credential = Pick<IdentitySchema<'ApiTokenCreatedDto'>, 'id' | 'name' | 'expiresAt' | 'token'>;
export const TOKEN_LIFETIMES = [1, 7, 30, 90] as const;
const validLifetime = (value: number) => TOKEN_LIFETIMES.some((days) => days === value);
const nameValidator: ValidatorFn = (control) => {
  const value: unknown = control.value;
  return typeof value === 'string' &&
    value.trim() &&
    Array.from(value.trim()).length <= 64 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    ? null
    : { name: true };
};

@Injectable()
export class TokenFormStore {
  private readonly api = inject(IdentityApi);
  private readonly session = inject(SessionStore);
  private readonly destroyRef = inject(DestroyRef);
  readonly submission = inject(MutationRunner);
  #revision = 0;
  #cursors: (string | undefined)[] = [undefined];
  private readonly now = signal(Date.now());
  #credential = signal<Credential | null>(null);
  readonly credential = this.#credential.asReadonly();
  private readonly rows = signal<readonly Token[]>([]);
  private readonly cursor = signal<string | null>(null);
  private readonly pageIndex = signal(0);
  private readonly loadState = signal<'loading' | 'ready' | 'unavailable'>('loading');
  private readonly currentMode = signal<'idle' | 'create' | 'revoke'>('idle');
  private readonly target = signal<Token | null>(null);
  private readonly mfa = signal(false);
  private readonly expiry = signal<string | null>(null);
  private readonly message = signal<string | null>(null);
  private readonly validation = signal<string | null>(null);
  private readonly grant = signal<TokenGrant>(PROFILE_ONLY);
  readonly items = this.rows.asReadonly();
  readonly nextCursor = this.cursor.asReadonly();
  readonly page = this.pageIndex.asReadonly();
  readonly state = this.loadState.asReadonly();
  readonly mode = this.currentMode.asReadonly();
  readonly selected = this.target.asReadonly();
  readonly mfaRequired = this.mfa.asReadonly();
  readonly expiresAt = this.expiry.asReadonly();
  readonly notice = this.message.asReadonly();
  readonly problem = this.validation.asReadonly();
  readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [nameValidator] }),
    lifetimeDays: new FormControl(7, {
      nonNullable: true,
      validators: [
        (control) =>
          typeof control.value === 'number' && validLifetime(control.value)
            ? null
            : { lifetime: true },
      ],
    }),
    password: new FormControl('', { nonNullable: true, validators: [passwordValidator] }),
    factor: new FormControl('', { nonNullable: true }),
    factorKind: new FormControl<'totp' | 'recovery'>('totp', { nonNullable: true }),
  });

  constructor() {
    const clock = setInterval(() => {
      this.now.set(Date.now());
    }, 30000);
    this.form.controls.lifetimeDays.valueChanges.pipe(takeUntilDestroyed()).subscribe((days) => {
      this.updateExpiry(days);
    });
    this.form.controls.factorKind.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.form.controls.factor.reset('', { emitEvent: false });
      this.configureProof();
    });
    this.destroyRef.onDestroy(() => {
      clearInterval(clock);
      this.resetForSession();
    });
  }
  toJSON(): string {
    return '[TokenFormStore]';
  }
  async refresh(): Promise<void> {
    if (!this.submission.busy()) await this.loadPage(undefined, 0);
  }
  async nextPage(): Promise<void> {
    const cursor = this.nextCursor();
    if (cursor && this.state() === 'ready' && !this.submission.busy())
      await this.loadPage(cursor, this.page() + 1);
  }
  async previousPage(): Promise<void> {
    if (this.page() > 0 && this.state() === 'ready' && !this.submission.busy())
      await this.loadPage(this.#cursors.at(this.page() - 1), this.page() - 1);
  }
  resetForSession(): void {
    ++this.#revision;
    this.clearPrivate();
    this.rows.set([]);
    this.cursor.set(null);
    this.pageIndex.set(0);
    this.#cursors = [undefined];
    this.loadState.set('loading');
    this.currentMode.set('idle');
    this.message.set(null);
    this.validation.set(null);
    this.submission.reset();
  }
  /** What the token being created may do; the scope picker owns the choice. */
  setGrant(grant: TokenGrant): void {
    this.grant.set(grant);
  }
  /** One readable line per scope in the token list. */
  scopeLabel(scope: Token['scopes'][number]): string {
    if (scope.permission === 'profile.read') return 'Read account profile';
    const reach = scope.environmentId
      ? 'one environment'
      : scope.projectId
        ? 'one project'
        : 'whole organization';
    return `${scope.permission}, ${reach}`;
  }
  beginCreate(): boolean {
    if (!this.canEdit()) return false;
    this.begin('create');
    this.updateExpiry(this.form.controls.lifetimeDays.value);
    return true;
  }
  beginRevoke(id: string): boolean {
    const token = this.items().find((item) => item.id === id && this.statusFor(item) === 'active');
    if (!token || !this.canEdit()) return false;
    this.begin('revoke');
    this.target.set(token);
    return true;
  }
  statusFor(token: Token): Token['status'] {
    return token.status === 'active' && Date.parse(token.expiresAt) <= this.now()
      ? 'expired'
      : token.status;
  }
  dismiss(): void {
    if (this.submission.busy()) return;
    this.clearPrivate();
    this.currentMode.set('idle');
    this.validation.set(null);
    this.message.set(null);
    this.submission.reset();
  }
  errorFor(name: 'name' | 'lifetimeDays' | 'password' | 'factor'): string | null {
    const control = this.form.controls[name];
    if (!control.enabled || !control.touched || !control.invalid) return null;
    return {
      name: 'Use a name between 1 and 64 characters, without invisible characters.',
      lifetimeDays: 'Choose one of the available lifetimes.',
      password: 'Enter your current password (15–128 characters).',
      factor:
        this.form.controls.factorKind.value === 'totp'
          ? 'Enter the six-digit authenticator code.'
          : 'Enter one complete 32-character recovery code.',
    }[name];
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
    this.form.controls.factor.setValue(this.form.controls.factor.value.trim(), {
      emitEvent: false,
    });
    this.form.markAllAsTouched();
    this.form.updateValueAndValidity({ emitEvent: false });
    if (this.form.invalid) {
      this.validation.set('Check the marked fields before continuing.');
      return;
    }
    const { name, password, factor, factorKind } = this.form.getRawValue();
    const proof = { password, ...(this.mfaRequired() ? { [factorKind]: factor } : {}) };
    const expiresAt = this.expiresAt();
    const target = this.selected();
    if (mode === 'create' && (!expiresAt || Date.parse(expiresAt) < Date.now() + 60000)) {
      this.validation.set('This expiry is too close. Cancel and start a new token request.');
      return;
    }
    if (mode === 'revoke' && !target) return;
    const { scopes, project } = this.grant();
    if (mode === 'create' && !scopes.length) {
      this.validation.set('Choose at least one permission for this token.');
      return;
    }
    const body = {
      ...proof,
      name: name.trim(),
      expiresAt: expiresAt ?? '',
      scopes: [...scopes],
      ...(project ? { project } : {}),
    };
    const result = await this.submission.run(
      mode === 'create' ? body : { id: target?.id, ...proof },
      async (key) => {
        if (mode === 'create') return this.api.createToken(body, key);
        if (target) await this.api.revokeToken(target.id, proof, key);
        return null;
      },
    );
    if (!result.ok) return;
    this.clearPrivate();
    this.currentMode.set('idle');
    if (result.value) {
      const { id, name, token, expiresAt } = result.value;
      this.#credential.set({ id, name, token, expiresAt });
      // No timer: the server shows the token once, so it stays until the user acknowledges it,
      // leaves the page or rotates the session (WCAG 2.2.1, timing adjustable).
      this.message.set('Your API token has been created.');
    } else this.message.set('The API token has been revoked.');
    await this.refresh();
  }

  private canEdit(): boolean {
    return this.state() === 'ready' && !this.submission.busy() && !this.credential();
  }
  private begin(mode: 'create' | 'revoke'): void {
    this.clearPrivate();
    this.submission.reset();
    this.currentMode.set(mode);
    this.message.set(null);
    this.validation.set(null);
    for (const control of [this.form.controls.name, this.form.controls.lifetimeDays]) {
      if (mode === 'create') control.enable({ emitEvent: false });
      else control.disable({ emitEvent: false });
    }
    this.configureProof();
  }
  private clearPrivate(): void {
    this.#credential.set(null);
    this.target.set(null);
    this.expiry.set(null);
    this.grant.set(PROFILE_ONLY);
    this.form.reset({}, { emitEvent: false });
  }
  private updateExpiry(days: number): void {
    this.expiry.set(
      validLifetime(days) ? new Date(Date.now() + days * 86400000).toISOString() : null,
    );
  }
  private configureProof(): void {
    const { factor, factorKind } = this.form.controls;
    factor.setValidators([
      (control) => Validators.required(control),
      Validators.pattern(factorKind.value === 'totp' ? /^\d{6}$/ : /^[a-f0-9]{32}$/),
    ]);
    if (this.mfaRequired()) {
      factor.enable({ emitEvent: false });
      factorKind.enable({ emitEvent: false });
    } else {
      factor.disable({ emitEvent: false });
      factorKind.disable({ emitEvent: false });
    }
  }
  private async loadPage(cursor: string | undefined, page: number): Promise<void> {
    const revision = ++this.#revision;
    this.loadState.set('loading');
    try {
      const [result, mfa] = await Promise.all([this.api.listTokens(cursor), this.api.mfaStatus()]);
      if (this.destroyRef.destroyed || revision !== this.#revision) return;
      this.rows.set(result.items);
      this.cursor.set(result.nextCursor);
      this.mfa.set(mfa.enabled);
      this.pageIndex.set(page);
      this.#cursors = [...this.#cursors.slice(0, page), cursor];
      this.configureProof();
      this.loadState.set('ready');
    } catch (error: unknown) {
      if (this.destroyRef.destroyed || revision !== this.#revision) return;
      this.rows.set([]);
      this.cursor.set(null);
      this.loadState.set('unavailable');
      if (error instanceof IdentityRequestError && error.status === 401) this.session.clear();
    }
  }
}
