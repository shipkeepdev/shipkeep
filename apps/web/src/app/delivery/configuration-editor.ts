import { ChangeDetectionStrategy, Component, effect, inject, input } from '@angular/core';

import { MutationRunner } from '../identity/mutation-runner';
import { T } from '../ui/i18n';

import { ConfigurationEditorStore } from './configuration-editor-store';
import { type Application, type EnvironmentRef } from './delivery-api';

@Component({
  selector: 'sk-configuration-editor',
  imports: [T],
  providers: [MutationRunner, ConfigurationEditorStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="configuration-title" class="border-t border-line pt-6">
      <h2 id="configuration-title">{{ 'Configuration' | t }}</h2>
      <p id="config-hint" class="hint mb-4">
        {{ 'Edit' | t }} <code>shipkeep.yml</code
        >{{
          ", then review your changes. Saving does not deploy them. Reference secrets by name; keep their values in the environment's Secrets section."
            | t
        }}
      </p>
      <p class="mb-4 text-sm text-muted">
        {{ 'Version' | t }} <code>{{ store.current()?.configSha?.slice(0, 12) }}</code>
      </p>
      @if (store.conflict()) {
        <div class="feedback" role="alert">
          <p>
            {{ 'The configuration changed since you opened it. Your draft has been kept.' | t }}
          </p>
          <button
            class="button button-secondary mt-3"
            type="button"
            [disabled]="store.runner.busy() || !!store.runner.cooldown()"
            (click)="store.reload()"
          >
            {{ (store.runner.busy() ? 'Loading…' : 'Load latest version') | t }}
          </button>
        </div>
      }
      @if (store.runner.problem(); as problem) {
        <p class="feedback" role="alert">{{ problem | t }}</p>
      }
      @if (store.notice(); as notice) {
        <p class="feedback" role="status">{{ notice | t }}</p>
      }
      @if (store.issues().length) {
        <div id="config-errors" class="feedback" role="alert">
          <p>{{ 'Fix these configuration errors:' | t }}</p>
          <ul class="list-disc pl-5">
            @for (issue of store.issues(); track $index) {
              <li>
                <code>{{ issue.path || '/' }}</code> {{ issue.message | t }}
              </li>
            }
          </ul>
        </div>
      }
      <form (submit)="$event.preventDefault(); store.review()" class="grid gap-4">
        <div>
          <label for="configuration-draft">shipkeep.yml</label>
          <textarea
            #editor
            id="configuration-draft"
            class="block min-h-72 w-full resize-y rounded-md border border-control p-3 font-mono text-sm caret-accent disabled:bg-panel"
            [class.border-danger]="store.issues().length > 0"
            spellcheck="false"
            autocomplete="off"
            [value]="store.draft()"
            [readOnly]="store.runner.busy()"
            [attr.aria-invalid]="store.issues().length > 0"
            [attr.aria-describedby]="
              store.issues().length ? 'config-hint config-errors' : 'config-hint'
            "
            (input)="store.edit(editor.value)"
          ></textarea>
        </div>
        <div>
          <button
            class="button button-secondary"
            type="submit"
            [disabled]="store.runner.busy() || store.conflict()"
          >
            {{ 'Review changes' | t }}
          </button>
        </div>
      </form>
      @if (store.diff().length) {
        <div class="mt-6">
          <h3 class="mb-2 font-semibold">{{ 'Changes to save' | t }}</h3>
          <p class="hint mb-3">{{ '− Current version · + Your draft' | t }}</p>
          <pre
            class="mb-4 max-h-96 overflow-auto rounded-md bg-panel p-4 text-sm"
            tabindex="0"
            [attr.aria-label]="'Configuration changes' | t"
          >@for (line of store.diff(); track $index) {<span class="block" [class.text-danger]="line.startsWith('- ')" [class.text-success]="line.startsWith('+ ')">{{ line }}</span>}</pre>
          <button
            class="button"
            type="button"
            [disabled]="
              store.runner.busy() ||
              store.conflict() ||
              !!store.runner.cooldown() ||
              store.runner.restartRequired()
            "
            (click)="store.save()"
          >
            {{ (store.runner.busy() && !store.conflict() ? 'Saving…' : 'Save configuration') | t }}
          </button>
        </div>
      }
      @if (store.runner.cooldown()) {
        <p role="status" class="hint">
          {{ 'Try again in {s} seconds.' | t: { s: store.runner.cooldown() } }}
        </p>
      }
    </section>
  `,
})
export class ConfigurationEditor {
  protected readonly store = inject(ConfigurationEditorStore);
  readonly application = input.required<Application>();
  readonly environment = input.required<EnvironmentRef>();

  constructor() {
    effect(() => {
      this.store.open(this.environment(), this.application());
    });
  }
}
