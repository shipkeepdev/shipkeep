import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { type ConfigIssue, parseShipkeepConfig } from '@shipkeep/config-schema';

import { deploymentStatus } from '../dashboard/format';
import { MutationRunner } from '../identity/mutation-runner';
import { Icon } from '../shell/icon';
import { T } from '../ui/i18n';
import { Collection } from '../workspace/collection';
import { recoverOnEdit } from '../workspace/form-recovery';

import {
  type Application,
  DeliveryApi,
  type Deployment,
  type EnvironmentRef,
} from './delivery-api';

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
  imports: [Icon, ReactiveFormsModule, RouterLink, T],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-2.5">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-[14px] font-medium">{{ 'Resources' | t }}</span>
        </div>
        <div class="card overflow-x-auto">
          <div class="min-w-[620px]">
            <div [class]="columns + ' grid-table th px-[18px] py-[11px]'">
              <span>{{ 'Name' | t }}</span
              ><span>{{ 'Type' | t }}</span
              ><span>{{ 'Image' | t }}</span
              ><span>{{ 'State' | t }}</span
              ><span>{{ 'Deployed' | t }}</span>
            </div>
            @switch (list.state()) {
              @case ('loading') {
                <p
                  role="status"
                  class="border-t border-line2 px-[18px] py-3 text-[12.5px] text-mute2"
                >
                  {{ 'Loading…' | t }}
                </p>
              }
              @case ('failed') {
                <p
                  role="alert"
                  class="border-t border-line2 px-[18px] py-3 text-[12.5px] text-rose"
                >
                  {{ list.problem() | t }}
                </p>
              }
              @default {
                @for (application of list.items(); track application.id) {
                  @let last = latest().get(application.id);
                  @let s = last ? status(last.state) : null;
                  <div
                    [class]="
                      columns +
                      ' relative grid-table border-t border-line2 px-[18px] py-3 text-[12.5px] hover:bg-[#0a0a0b]'
                    "
                  >
                    <span class="flex min-w-0 items-center gap-[7px] text-fg2"
                      ><sk-icon name="box" class="text-[15px] text-mute" /><a
                        [routerLink]="['applications', application.id]"
                        class="truncate after:absolute after:inset-0"
                        >{{ application.name }}</a
                      ></span
                    >
                    <span class="text-fg2">{{ 'Application' | t }}</span>
                    <span class="truncate font-mono text-fg2">{{ image(application) }}</span>
                    @if (s) {
                      <span class="flex items-center gap-[7px]" [style.color]="s.color"
                        ><span class="dot" [style.background]="s.color"></span
                        >{{ s.label | t }}</span
                      >
                    } @else {
                      <span class="text-dim">{{ 'never deployed' | t }}</span>
                    }
                    <span class="text-dim">{{
                      last
                        ? (last.finishedAt ?? last.startedAt).slice(0, 16).replace('T', ' ')
                        : '—'
                    }}</span>
                  </div>
                } @empty {
                  <p class="border-t border-line2 px-[18px] py-3 text-[12.5px] text-mute2">
                    {{ 'No application yet.' | t }}
                  </p>
                }
              }
            }
          </div>
        </div>
      </div>

      <section
        class="card flex flex-col gap-3 p-5"
        aria-labelledby="applications-create-title"
        [style.border-color]="'rgba(255,92,92,0.35)'"
      >
        <div class="flex flex-wrap items-center gap-3.5">
          <span class="grid size-10 shrink-0 place-items-center rounded-[11px] border border-ctl"
            ><sk-icon name="file-code" class="text-[20px] text-fg"
          /></span>
          <div class="min-w-0 flex-[1_1_200px]">
            <h2
              id="applications-create-title"
              class="flex flex-wrap items-center gap-2 text-[14px] font-medium"
            >
              {{ 'From a shipkeep.yml' | t }}<span class="tag-ours">Shipkeep</span>
            </h2>
            <div class="mt-[3px] text-[12.5px] leading-[1.45] text-mute2">
              {{ 'Paste the file. Only image applications can be created for now.' | t }}
            </div>
          </div>
        </div>
        @if (runner.problem(); as problem) {
          <div class="alert" role="alert">{{ problem | t }}</div>
        }
        @if (issues().length) {
          <div class="alert" role="alert">
            <div>
              <p>{{ 'The configuration is invalid:' | t }}</p>
              <ul class="m-0 mt-1 list-disc pl-5">
                @for (issue of issues(); track $index) {
                  <li>
                    <code class="font-mono">{{ issue.path || '/' }}</code> {{ issue.message }}
                  </li>
                }
              </ul>
            </div>
          </div>
        }
        <form [formGroup]="form" (ngSubmit)="create()" class="flex flex-col gap-3">
          <label for="application-config" class="sr-only">shipkeep.yml</label>
          <textarea
            id="application-config"
            class="input min-h-56 font-mono text-[12px] leading-[1.75]"
            spellcheck="false"
            formControlName="config"
          ></textarea>
          <div>
            <button
              class="btn btn-primary"
              type="submit"
              [disabled]="runner.busy() || !!runner.cooldown()"
            >
              {{ (runner.busy() ? 'Creating…' : 'Create application') | t
              }}<sk-icon name="arrow-right" />
            </button>
          </div>
        </form>
      </section>
    </div>
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
  protected readonly status = deploymentStatus;
  protected readonly columns =
    'grid-cols-[minmax(0,1.5fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,0.9fr)_minmax(0,0.9fr)]';
  /** The latest deployment of each application, for the state column. */
  protected readonly latest = signal<ReadonlyMap<string, Deployment>>(new Map());

  constructor() {
    recoverOnEdit(this.form, this.runner);
    effect(() => {
      this.environment();
      void this.list.refresh();
    });
    effect(() => {
      const ref = this.environment();
      const apps = this.list.items();
      void Promise.all(
        apps.map(async (app) => {
          const deployments = await this.api.deployments(ref, app.id).catch(() => []);
          return [app.id, deployments.at(0)] as const;
        }),
      ).then((pairs) => {
        this.latest.set(
          new Map(pairs.filter((pair): pair is readonly [string, Deployment] => !!pair[1])),
        );
      });
    });
  }

  protected image(application: Application): string {
    const build = (application.config as { build?: { image?: unknown } }).build;
    return typeof build?.image === 'string' ? build.image : application.source;
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
