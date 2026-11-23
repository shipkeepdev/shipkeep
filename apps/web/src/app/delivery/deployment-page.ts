import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { duration } from '../dashboard/format';
import { PageCrumbs } from '../dashboard/page-crumbs';
import { IdentityRequestError } from '../identity/identity-api';
import { Icon } from '../shell/icon';
import { ShellContext } from '../shell/shell-context';
import { I18n, T } from '../ui/i18n';
import { WorkspaceApi } from '../workspace/workspace-api';

import {
  type Application,
  DeliveryApi,
  type Deployment,
  type DeploymentTimeline,
  type EnvironmentRef,
  type Release,
} from './delivery-api';
import { deploymentKind, KIND_CAUSE, KIND_TITLE } from './deployment-kind';
import { deploymentView, type Text, timelineEnded } from './deployment-view';

/** While a deployment runs, its page reads it again this often, as the application page does. */
const POLL_MS = 3000;
/** Once it has finished, how many more times the page reads a timeline still missing its end. */
const SETTLE_READS = 3;

/** 15 Deployment (#265): what one deployment went through, step by step, live while it runs. */
@Component({
  selector: 'sk-deployment-page',
  imports: [Icon, RouterLink, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (state()) {
      @case ('loading') {
        <p role="status" class="text-[13px] text-mute2">{{ 'Loading…' | t }}</p>
      }
      @case ('missing') {
        <div class="page">
          <h1 class="page-title">{{ 'Deployment not found' | t }}</h1>
          <p class="text-[13px] text-mute2">
            {{ 'This deployment does not exist in this application, or you cannot see it.' | t }}
          </p>
          <a class="btn btn-sm self-start" [routerLink]="applicationLink()"
            ><sk-icon name="box" />{{ 'Application' | t }}</a
          >
        </div>
      }
      @case ('failed') {
        <div class="page">
          <p role="alert" class="text-[13px] text-mute2">
            {{ 'This deployment could not be read.' | t }}
          </p>
          <button type="button" class="btn btn-sm self-start" (click)="load()">
            {{ 'Read again' | t }}
          </button>
        </div>
      }
      @default {
        @if (view(); as v) {
          <div class="flex flex-col gap-[18px]">
            <div class="page-head">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-3">
                  <h1 class="page-title">{{ title() }}</h1>
                  <span class="pill" [style.color]="v.status.color"
                    ><span class="dot" [style.background]="v.status.color"></span
                    >{{ v.status.label | t }}</span
                  >
                  <span class="pill">{{ elapsed() }}</span>
                </div>
                <div class="mt-1.5 max-w-[720px] text-[13px] text-pretty text-mute2">
                  {{ sub() }}
                </div>
              </div>
              <div class="flex flex-wrap gap-2.5">
                <a
                  class="btn"
                  [routerLink]="applicationLink()"
                  [queryParams]="{ tab: 'deployments' }"
                  ><sk-icon name="box" />{{ 'Application' | t }}</a
                >
              </div>
            </div>

            @if (v.stats.length) {
              <div class="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
                @for (s of v.stats; track $index) {
                  <div class="rounded-[14px] border border-line bg-black px-4 py-3.5">
                    <div class="flex items-center gap-[7px] text-[12px] text-mute">
                      <sk-icon [name]="s.icon" class="text-[14px]" />{{ s.label | t }}
                    </div>
                    <div
                      class="mt-2 text-[24px] tracking-[-0.02em]"
                      [style.color]="s.color || '#EDEDEF'"
                    >
                      {{ say(s.duration) }}
                    </div>
                    <div class="mt-0.5 font-mono text-[11px] text-dim">{{ s.at }}</div>
                  </div>
                }
              </div>
            }

            <section class="flex flex-col gap-2.5" aria-labelledby="timeline-title">
              <div class="flex items-baseline justify-between gap-3">
                <h2 id="timeline-title" class="text-[14px] font-medium">
                  {{ 'Timeline' | t }}
                </h2>
                <span class="text-[12px] text-dim">{{ 'steps and agent actions' | t }}</span>
              </div>
              <div
                class="max-h-[480px] overflow-auto rounded-[14px] border border-line bg-black px-4 py-3.5 font-mono text-[12px] leading-[1.8]"
              >
                @for (l of v.lines; track l.key) {
                  <div class="whitespace-pre-wrap" [style.color]="l.color || '#C8C8CF'">
                    <span class="text-dim3">{{ l.at }} </span>{{ join(l.parts) }}
                  </div>
                } @empty {
                  <div class="text-dim">{{ 'No step recorded for this deployment.' | t }}</div>
                }
                @if (!v.finished) {
                  <div class="text-blue">{{ 'now' | t }} · {{ v.status.label | t }}…</div>
                }
              </div>
              @if (v.truncated) {
                <div class="note note-warn">
                  <sk-icon name="alert-triangle" class="text-amber" />
                  <span>{{ 'Only the first 200 agent actions are listed.' | t }}</span>
                </div>
              }
              <!-- A stop or a maintenance change builds nothing and runs no release command. -->
              @if (deploys()) {
                <div class="note">
                  <sk-icon name="info-circle" class="text-mute" />
                  <span>{{
                    'Build output and the output of the release command will appear here with builds and log collection.'
                      | t
                  }}</span>
                </div>
              }
            </section>
          </div>
        }
      }
    }
  `,
})
export class DeploymentPage {
  readonly organizationId = input.required<string>();
  readonly projectId = input.required<string>();
  readonly environmentId = input.required<string>();
  readonly applicationId = input.required<string>();
  readonly deploymentId = input.required<string>();
  private readonly api = inject(DeliveryApi);
  private readonly workspace = inject(WorkspaceApi);
  private readonly shell = inject(ShellContext);
  private readonly i18n = inject(I18n);
  private readonly crumbs = inject(PageCrumbs);
  protected readonly deployment = signal<Deployment | null>(null);
  private readonly timeline = signal<DeploymentTimeline | null>(null);
  private readonly application = signal<Application | null>(null);
  private readonly environmentName = signal<string | null>(null);
  private readonly releases = signal<readonly Release[]>([]);
  /** The release this deployment ran, when it is among the 50 most recent. */
  private readonly release = computed(() => {
    const d = this.deployment();
    return d ? (this.releases().find((release) => release.id === d.releaseId) ?? null) : null;
  });
  protected readonly state = signal<'loading' | 'ready' | 'missing' | 'failed'>('loading');
  private readonly now = signal(Date.now());
  /** Bumped by every read, so only the latest one lands. */
  #revision = 0;
  /** Bumped when the page shows another deployment or goes away, so older names never land. */
  #context = 0;
  #settling = SETTLE_READS;
  #timer: ReturnType<typeof setTimeout> | undefined;

  private readonly environment = computed<EnvironmentRef>(() => ({
    organizationId: this.organizationId(),
    projectId: this.projectId(),
    environmentId: this.environmentId(),
  }));
  protected readonly applicationLink = computed(() => [
    '/orgs',
    this.organizationId(),
    'projects',
    this.projectId(),
    'environments',
    this.environmentId(),
    'applications',
    this.applicationId(),
  ]);
  protected readonly view = computed(() => {
    const deployment = this.deployment();
    const timeline = this.timeline();
    return deployment && timeline ? deploymentView(deployment, timeline, this.now()) : null;
  });
  /** True for a deployment of a release, the only kind with build and release output. */
  protected readonly deploys = computed(() => {
    const d = this.deployment();
    return d ? deploymentKind(d) === 'deploy' : false;
  });
  protected readonly title = computed(() => {
    const d = this.deployment();
    if (!d) return '';
    // The release number, as the application's agent actions name it; its id when unknown.
    const number = this.release()?.number;
    return this.i18n.t(KIND_TITLE[deploymentKind(d)], {
      release: number === undefined ? d.releaseId.slice(0, 7) : `#${String(number)}`,
    });
  });
  protected readonly elapsed = computed(() => {
    const d = this.deployment();
    return d ? duration(d.startedAt, d.finishedAt, this.now()) : '';
  });
  /** The application and environment as typed, how it started and who started it. */
  protected readonly sub = computed(() => {
    const d = this.deployment();
    if (!d) return '';
    const actor = d.actorId ? this.shell.names().get(d.actorId) : undefined;
    return [
      this.application()?.name,
      this.environmentName(),
      // A stop or a maintenance change runs the release that serves: no image of its own.
      deploymentKind(d) === 'deploy' ? this.release()?.image : null,
      this.i18n.t(KIND_CAUSE[deploymentKind(d)] ?? d.trigger),
      actor ? this.i18n.t('by {name}', { name: actor }) : null,
    ]
      .filter(Boolean)
      .join(' · ');
  });

  constructor() {
    effect(() => {
      this.environment();
      this.applicationId();
      this.deploymentId();
      untracked(() => {
        this.#context++;
        this.#settling = SETTLE_READS;
        this.deployment.set(null);
        this.timeline.set(null);
        this.application.set(null);
        this.environmentName.set(null);
        this.releases.set([]);
        this.state.set('loading');
        void this.load();
        void this.loadNames();
      });
    });
    // The shell loads its projects after the page may have its title: the trail waits for them.
    effect(() => {
      const title = this.title();
      const application = this.application();
      const environment = this.environmentName();
      const project = this.shell.projects().find((p) => p.id === this.projectId())?.name;
      if (!title) return;
      untracked(() => {
        const base = ['/orgs', this.organizationId(), 'projects', this.projectId()];
        this.crumbs.set([
          { label: project ?? '…', raw: true, link: base },
          {
            label: environment ?? '…',
            raw: true,
            link: [...base, 'environments', this.environmentId()],
          },
          { label: application?.name ?? '…', raw: true, link: this.applicationLink() },
          { label: title, raw: true },
        ]);
      });
    });
    const tick = setInterval(() => {
      this.now.set(Date.now());
    }, 1000);
    inject(DestroyRef).onDestroy(() => {
      // A read still on its way must neither land nor plan the next one.
      this.#revision++;
      this.#context++;
      clearInterval(tick);
      clearTimeout(this.#timer);
    });
  }

  /** Reads the deployment and its timeline, and again shortly while it runs. */
  protected async load(): Promise<void> {
    const revision = ++this.#revision;
    clearTimeout(this.#timer);
    const environment = this.environment();
    const applicationId = this.applicationId();
    const deploymentId = this.deploymentId();
    try {
      const [deployment, timeline] = await Promise.all([
        this.api.deployment(environment, applicationId, deploymentId),
        this.api.timeline(environment, applicationId, deploymentId),
      ]);
      if (revision !== this.#revision) return;
      this.deployment.set(deployment);
      this.timeline.set(timeline);
      this.state.set('ready');
      if (this.#again()) this.#next();
    } catch (error: unknown) {
      if (revision !== this.#revision) return;
      if (error instanceof IdentityRequestError && error.status === 404) {
        this.state.set('missing');
      } else if (this.state() !== 'ready') {
        this.state.set('failed');
      } else if (this.#again()) {
        // A read failed while the page followed it: keep what it shows and try again.
        this.#next();
      }
    }
  }

  /**
   * Whether to read again: while the deployment runs, then a few more times while its timeline
   * misses the step it ended with (read side by side, the timeline can lag one step behind).
   */
  #again(): boolean {
    const deployment = this.deployment();
    const timeline = this.timeline();
    if (!deployment || !timeline) return false;
    if (!deployment.finishedAt) {
      this.#settling = SETTLE_READS;
      return true;
    }
    if (timelineEnded(deployment, timeline) || this.#settling === 0) return false;
    this.#settling--;
    return true;
  }

  /** Plans the next read; a later read or the page's end clears it. */
  #next(): void {
    this.#timer = setTimeout(() => {
      void this.load();
    }, POLL_MS);
  }

  /** Names for the header and the trail; the page stands without them. */
  private async loadNames(): Promise<void> {
    const context = this.#context;
    const environment = this.environment();
    const [application, env, releases] = await Promise.all([
      this.api.application(environment, this.applicationId()).catch(() => null),
      this.workspace
        .environment(environment.organizationId, environment.projectId, environment.environmentId)
        .catch(() => null),
      this.api.releases(environment, this.applicationId()).catch(() => []),
    ]);
    if (context !== this.#context) return;
    this.application.set(application);
    this.environmentName.set(env?.name ?? null);
    this.releases.set(releases);
  }

  protected say(text: Text): string {
    return this.i18n.t(text.t, text.values);
  }

  /** The parts of a line, each translated, joined as the design writes them. */
  protected join(parts: readonly Text[]): string {
    return parts.map((part) => this.say(part)).join(' · ');
  }
}
