import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { Router } from '@angular/router';

import { DeliveryApi, type EnvironmentRef } from '../delivery/delivery-api';
import { MutationRunner } from '../identity/mutation-runner';
import { ShellContext } from '../shell/shell-context';
import { T } from '../ui/i18n';

/**
 * Clones an environment (issue #257): asks for the new name, says what is copied and what is not,
 * then opens the new environment.
 */
@Component({
  selector: 'sk-environment-clone',
  imports: [T],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card flex max-w-[720px] flex-col gap-3 p-5" aria-labelledby="clone-title">
      <h2 id="clone-title" class="text-[14px]">{{ 'Clone {name}' | t: { name: source() } }}</h2>
      <p class="text-[12.5px] text-mute2">
        {{
          'Applications and their configuration are copied, not deployed. Domains, secret values and data stay here: set the secrets in the new environment before deploying.'
            | t
        }}
      </p>
      @if (runner.problem(); as problem) {
        <div class="alert" role="alert">{{ problem | t }}</div>
      }
      <form class="flex flex-col gap-3" (submit)="$event.preventDefault(); clone()">
        <div class="flex max-w-[320px] flex-col gap-1.5">
          <label for="clone-name" class="text-[12px] text-fg3">{{
            'New environment name' | t
          }}</label>
          <input
            #field
            id="clone-name"
            class="input font-mono"
            autocomplete="off"
            spellcheck="false"
            maxlength="40"
            [value]="name()"
            (input)="rename(field.value)"
          />
          <span class="text-[11.5px] text-dim">{{
            'Lowercase letters, digits and hyphens, starting with a letter.' | t
          }}</span>
        </div>
        <div class="flex flex-wrap gap-2.5">
          <button
            class="btn btn-primary"
            type="submit"
            [disabled]="runner.busy() || !!runner.cooldown() || !name().trim()"
          >
            {{ (runner.busy() ? 'Cloning…' : 'Clone') | t }}
          </button>
          <button class="btn" type="button" [disabled]="runner.busy()" (click)="cancelled.emit()">
            {{ 'Cancel' | t }}
          </button>
        </div>
      </form>
    </section>
  `,
})
export class EnvironmentClone {
  private readonly api = inject(DeliveryApi);
  private readonly router = inject(Router);
  private readonly shell = inject(ShellContext);
  protected readonly runner = inject(MutationRunner);
  readonly environment = input.required<EnvironmentRef>();
  /** The source environment's name. */
  readonly source = input.required<string>();
  readonly cancelled = output();
  protected readonly name = signal('');

  protected rename(value: string): void {
    this.name.set(value);
    // A taken name is settled by another name: let the next attempt start afresh.
    if (this.runner.restartRequired()) this.runner.reset();
  }

  protected async clone(): Promise<void> {
    const name = this.name().trim();
    if (!name) return;
    const environment = this.environment();
    const outcome = await this.runner.run({ name }, () =>
      this.api.cloneEnvironment(environment, name),
    );
    if (!outcome.ok) return;
    void this.shell.refresh();
    await this.router.navigate([
      '/orgs',
      environment.organizationId,
      'projects',
      environment.projectId,
      'environments',
      outcome.value.environmentId,
    ]);
  }
}
