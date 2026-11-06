import { ChangeDetectionStrategy, Component, effect, inject, input } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';

import { MutationRunner } from '../identity/mutation-runner';
import { Collection } from '../workspace/collection';
import { required } from '../workspace/validators';

import { DeliveryApi, type EnvironmentRef, type SecretMetadata } from './delivery-api';

/** Write-only secrets (SPEC 9): names and versions are listed, values are never shown. */
@Component({
  selector: 'sk-secrets-panel',
  imports: [ReactiveFormsModule],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="secrets-title" class="border-t border-line pt-6">
      <h2 id="secrets-title">Secrets</h2>
      <p class="hint mb-3">Values are encrypted and can never be read back, only replaced.</p>
      @if (runner.problem(); as problem) {
        <div class="feedback" role="alert">
          <p>{{ problem }}</p>
        </div>
      }
      @switch (list.state()) {
        @case ('loading') {
          <p role="status" class="text-muted">Loading secrets…</p>
        }
        @case ('failed') {
          <div class="feedback" role="alert">
            <p>{{ list.problem() }}</p>
          </div>
        }
        @default {
          @if (list.items().length) {
            <ul class="mb-6 divide-y divide-line border-y border-line" aria-label="Secrets">
              @for (secret of list.items(); track secret.name) {
                <li class="flex items-center justify-between gap-4 py-3">
                  <span>
                    <code>{{ secret.name }}</code>
                    <span class="ml-2 text-sm text-muted">version {{ secret.version }}</span>
                  </span>
                  <button
                    class="button button-secondary"
                    type="button"
                    [attr.aria-label]="'Remove ' + secret.name"
                    [disabled]="runner.busy()"
                    (click)="remove(secret.name)"
                  >
                    Remove
                  </button>
                </li>
              }
            </ul>
          } @else {
            <p class="mb-6 border-y border-line py-6 text-muted">No secrets yet.</p>
          }
        }
      }
      <form [formGroup]="form" (ngSubmit)="set()" class="grid gap-4">
        <div>
          <label for="secret-name">Name</label>
          <input
            id="secret-name"
            formControlName="name"
            autocomplete="off"
            spellcheck="false"
            placeholder="DATABASE_URL"
          />
        </div>
        <div>
          <label for="secret-value">Value</label>
          <input id="secret-value" type="password" formControlName="value" autocomplete="off" />
        </div>
        <div>
          <button class="button" type="submit" [disabled]="runner.busy() || form.invalid">
            {{ runner.busy() ? 'Saving…' : 'Set secret' }}
          </button>
        </div>
      </form>
    </section>
  `,
})
export class SecretsPanel {
  private readonly api = inject(DeliveryApi);
  protected readonly runner = inject(MutationRunner);
  readonly environment = input.required<EnvironmentRef>();
  protected readonly list = new Collection<SecretMetadata>(() =>
    this.api.secrets(this.environment()),
  );
  protected readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [required, Validators.pattern(/^[A-Z_][A-Z0-9_]{0,127}$/)],
    }),
    value: new FormControl('', { nonNullable: true, validators: [required] }),
  });

  constructor() {
    effect(() => {
      this.environment();
      void this.list.refresh();
    });
  }

  protected async set(): Promise<void> {
    const { name, value } = this.form.getRawValue();
    // The value never enters the retry fingerprint or any log: only the name does.
    const outcome = await this.runner.run({ set: name }, () =>
      this.api.setSecret(this.environment(), name, value),
    );
    this.form.controls.value.reset();
    if (!outcome.ok) return;
    this.form.reset();
    await this.list.refresh();
  }

  protected async remove(name: string): Promise<void> {
    const outcome = await this.runner.run({ remove: name }, () =>
      this.api.removeSecret(this.environment(), name),
    );
    if (outcome.ok) await this.list.refresh();
  }
}
