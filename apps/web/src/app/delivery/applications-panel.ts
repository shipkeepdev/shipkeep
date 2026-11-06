import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { type ConfigIssue, parseShipkeepConfig } from '@shipkeep/config-schema';

import { MutationRunner } from '../identity/mutation-runner';
import { Collection } from '../workspace/collection';

import { type Application, DeliveryApi, type EnvironmentRef } from './delivery-api';

/** Starting point for a new application: an image, a port and a health check. */
export const EXAMPLE_CONFIG = `version: 1
name: my-app
build:
  type: image
  image: nginx:1.27
run:
  port: 80
  healthcheck:
    path: /
# domains: [app.example.com]
# secrets: [DATABASE_URL]
`;

/** Applications of an environment, and creating one from a shipkeep.yml document. */
@Component({
  selector: 'sk-applications-panel',
  imports: [ReactiveFormsModule, RouterLink],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="applications-title" class="border-t border-line pt-6">
      <h2 id="applications-title">Applications</h2>
      @switch (list.state()) {
        @case ('loading') {
          <p role="status" class="text-muted">Loading applications…</p>
        }
        @case ('failed') {
          <div class="feedback" role="alert">
            <p>{{ list.problem() }}</p>
          </div>
        }
        @default {
          @if (list.items().length) {
            <ul class="mb-8 divide-y divide-line border-y border-line" aria-label="Applications">
              @for (application of list.items(); track application.id) {
                <li class="py-3">
                  <a [routerLink]="['applications', application.id]">{{ application.name }}</a>
                  <span class="ml-2 text-sm text-muted">{{ application.source }}</span>
                </li>
              }
            </ul>
          } @else {
            <p class="mb-8 border-y border-line py-6 text-muted">No applications yet.</p>
          }
        }
      }
      <h3 class="mb-2 font-semibold">Create an application</h3>
      <p class="hint mb-3">
        Paste its <code>shipkeep.yml</code>. Only image applications can be created for now.
      </p>
      @if (runner.problem(); as problem) {
        <div class="feedback" role="alert">
          <p>{{ problem }}</p>
        </div>
      }
      @if (issues().length) {
        <div class="feedback" role="alert">
          <p>The configuration is invalid:</p>
          <ul class="list-disc pl-5">
            @for (issue of issues(); track $index) {
              <li>
                <code>{{ issue.path || '/' }}</code> {{ issue.message }}
              </li>
            }
          </ul>
        </div>
      }
      <form [formGroup]="form" (ngSubmit)="create()" class="grid gap-4">
        <div>
          <label for="application-config">shipkeep.yml</label>
          <textarea
            id="application-config"
            class="block min-h-64 w-full rounded-md border border-control p-3 font-mono text-sm"
            spellcheck="false"
            formControlName="config"
          ></textarea>
        </div>
        <div>
          <button class="button" type="submit" [disabled]="runner.busy()">
            {{ runner.busy() ? 'Creating…' : 'Create application' }}
          </button>
        </div>
      </form>
    </section>
  `,
})
export class ApplicationsPanel {
  private readonly api = inject(DeliveryApi);
  protected readonly runner = inject(MutationRunner);
  readonly environment = input.required<EnvironmentRef>();
  protected readonly list = new Collection<Application>(() =>
    this.api.applications(this.environment()),
  );
  protected readonly form = new FormGroup({
    config: new FormControl(EXAMPLE_CONFIG, { nonNullable: true }),
  });
  protected readonly issues = signal<readonly ConfigIssue[]>([]);

  constructor() {
    effect(() => {
      this.environment();
      void this.list.refresh();
    });
  }

  protected async create(): Promise<void> {
    // The same schema the API applies: problems show before anything is sent.
    const parsed = parseShipkeepConfig(this.form.controls.config.value);
    if (!parsed.ok) {
      this.issues.set(parsed.issues.slice(0, 20));
      return;
    }
    this.issues.set([]);
    const config = parsed.config;
    const outcome = await this.runner.run(config, () =>
      this.api.createApplication(this.environment(), config),
    );
    if (!outcome.ok) return;
    this.form.controls.config.setValue(EXAMPLE_CONFIG);
    await this.list.refresh();
  }
}
