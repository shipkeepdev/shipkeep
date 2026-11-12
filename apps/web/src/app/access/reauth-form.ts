import { ChangeDetectionStrategy, Component, effect, inject, input, output } from '@angular/core';
import { FormControl, type FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';

import { passwordValidator } from '../identity/auth-form-store';
import { MutationRunner } from '../identity/mutation-runner';
import { T } from '../ui/i18n';

import type { Proof } from './access-api';

export interface ReauthControls {
  password: FormControl<string>;
  code: FormControl<string>;
}
export const reauthControls = (): ReauthControls => ({
  password: new FormControl('', { nonNullable: true, validators: [passwordValidator] }),
  code: new FormControl('', {
    nonNullable: true,
    validators: [Validators.pattern(/^(?:[0-9]{6}|[a-f0-9]{32})?$/)],
  }),
});
/** Six digits are an authenticator code; anything else valid is a recovery code. */
export function reauthProof(password: string, code: string): Proof {
  if (!code) return { password };
  return code.length === 6 ? { password, totp: code } : { password, recovery: code };
}

/**
 * A form for a privilege change, each of which needs a fresh password and second factor (SPEC 7).
 * Credentials are cleared after every success; a code is single use, so also after every failure.
 */
@Component({
  selector: 'sk-reauth-form',
  imports: [ReactiveFormsModule, T],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (runner.problem(); as problem) {
      <div class="alert mb-3" role="alert">{{ problem | t }}</div>
    }
    <form [formGroup]="form()" (ngSubmit)="submit()" class="flex flex-col gap-3">
      <ng-content />
      <div class="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2.5">
        <div class="flex flex-col gap-1.5">
          <label [for]="prefix() + '-password'" class="text-[12px] text-fg3">{{
            'Your password' | t
          }}</label>
          <input
            [id]="prefix() + '-password'"
            class="input"
            type="password"
            [formControl]="controls().password"
            autocomplete="current-password"
            maxlength="128"
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <label [for]="prefix() + '-code'" class="text-[12px] text-fg3">{{
            'Authentication or recovery code' | t
          }}</label>
          <input
            [id]="prefix() + '-code'"
            class="input font-mono"
            [formControl]="controls().code"
            autocomplete="one-time-code"
            maxlength="32"
            spellcheck="false"
            [placeholder]="'if enabled' | t"
          />
        </div>
      </div>
      <div class="flex flex-wrap gap-2.5">
        <button
          class="btn btn-primary"
          type="submit"
          [disabled]="runner.busy() || !!runner.cooldown() || form().invalid"
        >
          {{ runner.busy() ? ('Working…' | t) : label() }}
        </button>
        <ng-content select="[secondary]" />
      </div>
    </form>
  `,
})
export class ReauthForm {
  protected readonly runner = inject(MutationRunner);
  readonly form = input.required<FormGroup>();
  readonly prefix = input.required<string>();
  readonly label = input.required<string>();
  /** Sends the command. The proof comes from this form, the rest of the body from the caller. */
  readonly send = input.required<(proof: Proof, key: string) => Promise<void>>();
  readonly done = output();

  constructor() {
    effect((onCleanup) => {
      const subscription = this.form().valueChanges.subscribe(() => {
        if (this.runner.restartRequired()) this.runner.reset();
      });
      onCleanup(() => {
        subscription.unsubscribe();
      });
    });
  }

  protected controls(): ReauthControls {
    return this.form().controls as unknown as ReauthControls;
  }

  protected async submit(): Promise<void> {
    if (this.form().invalid) return;
    const { password, code } = this.controls();
    const proof = reauthProof(password.value, code.value);
    const outcome = await this.runner.run(this.form().getRawValue(), (key) =>
      this.send()(proof, key),
    );
    // Without events: an edit restarts the runner, which would erase the problem just shown.
    code.reset('', { emitEvent: false });
    if (!outcome.ok) return;
    password.reset('', { emitEvent: false });
    this.done.emit();
  }
}
