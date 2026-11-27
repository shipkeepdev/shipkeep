import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { BlockView } from '../dashboard/block-view';
import {
  clock,
  deploymentStatus,
  duration,
  servingStatus,
  shortDate,
  BLUE,
  GREEN,
  RED,
} from '../dashboard/format';
import { PageCrumbs } from '../dashboard/page-crumbs';
import { PreviewPill } from '../dashboard/screen-view';
import { Icon } from '../shell/icon';
import { Brand } from '../ui/brand';
import { Count, I18n, T } from '../ui/i18n';
import { WorkspaceApi, type Environment } from '../workspace/workspace-api';

import { IdentityRequestError } from '../identity/identity-api';
import { MutationRunner } from '../identity/mutation-runner';
import { ShellContext } from '../shell/shell-context';
import { type Tab, Tabs } from '../shell/tabs';
import { Collection } from '../workspace/collection';

import { APP_SAMPLES, APP_SECTIONS, type SectionCopy } from './application-design';
import { AgentActionsPanel } from './agent-actions-panel';
import { LogsPanel } from './logs-panel';
import { TerminalPanel } from './terminal-panel';
import { ApplicationDanger } from './application-danger';
import { configSection } from './config-sections';
import { ConfigurationEditor } from './configuration-editor';
import { LiveEvents } from './live-events';
import { MetricChart, sumSeries } from './metric-chart';
import { ReleaseHistory } from './release-history';
import {
  type Application,
  type ApplicationMetrics,
  DeliveryApi,
  type Deployment,
  type DomainStatus,
  type EnvironmentRef,
  type MetricsRange,
  type Release,
  type Replica,
  type SecretMetadata,
} from './delivery-api';
import {
  deploymentKind,
  inMaintenance,
  KIND_CAUSE,
  KIND_TITLE,
  ranAVersion,
} from './deployment-kind';
import { startTarget } from './start-target';

const STEPS: readonly { label: string; states: readonly string[] }[] = [
  { label: 'Queued', states: ['queued'] },
  { label: 'Build', states: ['building', 'built'] },
  { label: 'Release', states: ['releasing'] },
  { label: 'Placement', states: ['scheduling', 'starting'] },
  { label: 'Health check', states: ['health_checking'] },
  { label: 'Switchover', states: ['switching', 'draining'] },
];
/** A stop goes from the queue straight to removing what runs (SPEC 5.1). */
const STOP_STEPS: typeof STEPS = [
  { label: 'Queued', states: ['queued'] },
  { label: 'Routes and replicas removed', states: ['draining'] },
];
/** A maintenance change only switches the routes; the replicas keep running (ADR 0025). */
const MAINTENANCE_STEPS: typeof STEPS = [
  { label: 'Queued', states: ['queued'] },
  { label: 'Routes switched', states: ['switching'] },
];
const SAMPLE_SECTIONS = new Set(['tasks', 'approvals', 'webhooks']);
/** Sections with their own content instead of configuration blocks. */
const OWN_SECTIONS = new Set(['yml', 'rollback', 'actions', 'danger']);

const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'rolled_back']);
/** While a deployment runs, its state is refreshed this often. */
const POLL_MS = 3000;
/** With live updates, polling only covers an event the stream could miss. */
const LIVE_POLL_MS = 15_000;
/**
 * With nothing running, the page still looks again this often: a change hint can be missed, since
 * an event may commit after a later one the stream already sent (SPEC 8, issue #492).
 */
const IDLE_POLL_MS = 60_000;

/** One application: its configuration, deploying it and following its deployments. */
@Component({
  selector: 'sk-application-page',
  imports: [
    AgentActionsPanel,
    LogsPanel,
    TerminalPanel,
    ApplicationDanger,
    BlockView,
    Brand,
    ConfigurationEditor,
    Count,
    Icon,
    MetricChart,
    PreviewPill,
    ReleaseHistory,
    RouterLink,
    T,
    Tabs,
  ],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let current = application();
    <div class="page">
      <div class="page-head">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-3">
            <h1 class="page-title whitespace-nowrap">{{ current?.name ?? '…' }}</h1>
            @if (headline(); as h) {
              <span class="pill" [style.color]="h.color" [attr.role]="active() ? 'status' : null"
                ><span class="dot" [style.background]="h.color"></span>{{ h.label | t }}</span
              >
            }
            <span class="pill"
              >{{ environmentName() }}
              @if (protectedEnvironment()) {
                · {{ 'protected' | t }}
              }
            </span>
          </div>
          <div class="mt-2 flex flex-wrap gap-4 text-[12.5px] text-mute2">
            @if (firstDomain(); as domain) {
              <span class="flex items-center gap-[5px] font-mono text-fg2"
                ><sk-icon name="lock" class="text-[13px]" />https://{{ domain }}</span
              >
            }
            @if (image(); as img) {
              <span class="flex min-w-0 items-center gap-[5px]"
                ><sk-brand name="docker" class="size-[13px] shrink-0 text-mute" /><span
                  class="font-mono break-all"
                  >{{ img }}</span
                ></span
              >
            }
            <span>{{
              replicas.items().length
                | count
                  : '{running} of {n} replica running'
                  : '{running} of {n} replicas running'
                  : { running: running() }
            }}</span>
          </div>
        </div>
        <div class="flex flex-wrap gap-2.5">
          @if (active(); as run) {
            <button
              class="btn"
              type="button"
              [disabled]="runner.busy() || !!runner.cooldown()"
              (click)="cancel(run.id)"
            >
              <sk-icon name="x" />{{ 'Cancel deployment' | t }}
            </button>
          } @else if (startable(); as start) {
            <button
              class="btn"
              type="button"
              [disabled]="runner.busy() || !!runner.cooldown()"
              (click)="rollback(start.id)"
            >
              <sk-icon name="player-play" />{{
                'Start {release}' | t: { release: releaseLabel(start) }
              }}
            </button>
          } @else if (previous(); as prev) {
            <button
              class="btn"
              type="button"
              [disabled]="runner.busy() || !!runner.cooldown()"
              (click)="rollback(prev.id)"
            >
              <sk-icon name="arrow-back-up" />{{
                'Roll back to {release}' | t: { release: releaseLabel(prev) }
              }}
            </button>
          }
          <button
            class="btn btn-primary"
            type="button"
            [style.background]="active() ? '#8B8B93' : null"
            [disabled]="
              !current || runner.busy() || !!runner.cooldown() || !!active() || maintained()
            "
            (click)="deploy()"
          >
            <sk-icon name="rocket" />{{
              (active() ? 'Deploying…' : runner.busy() ? 'Starting…' : 'Deploy') | t
            }}
          </button>
        </div>
      </div>
      @if (missing()) {
        <div class="alert" role="alert">{{ missing() | t }}</div>
      }
      @if (maintained()) {
        <div class="note note-warn flex-wrap items-center" role="status">
          <sk-icon name="alert-triangle" class="text-amber" />
          <span class="min-w-[200px] flex-1">{{
            'In maintenance: visitors see the maintenance page, and the replicas keep running. Leave maintenance to deploy again.'
              | t
          }}</span>
          <a
            class="btn btn-xs"
            [routerLink]="[]"
            [queryParams]="{ tab: 'config', section: 'danger' }"
            >{{ 'Leave maintenance' | t }}</a
          >
        </div>
      }
      @if (runner.problem(); as problem) {
        <div class="alert" role="alert">{{ problem | t }}</div>
      }
      @if (current) {
        <sk-tabs label="Application sections" [tabs]="tabs()" [(active)]="tab" />

        <div
          id="panel-config"
          role="tabpanel"
          aria-labelledby="tab-config"
          [hidden]="tab() !== 'config'"
          class="grid items-start gap-7 md:grid-cols-[210px_minmax(0,1fr)]"
        >
          <nav
            class="flex flex-col gap-0.5 max-md:flex-row max-md:overflow-x-auto md:sticky md:top-3"
            [attr.aria-label]="'Configuration' | t"
          >
            @for (x of menu; track x.k) {
              <div class="flex shrink-0 flex-col">
                @if (x.head) {
                  <div class="sidenav-head max-md:hidden">{{ x.head | t }}</div>
                }
                <a
                  class="sidenav-item max-md:whitespace-nowrap"
                  [class.danger]="x.k === 'danger'"
                  [routerLink]="[]"
                  [queryParams]="{ tab: 'config', section: x.k }"
                  [attr.aria-current]="x.k === section() ? 'page' : null"
                >
                  <sk-icon [name]="x.icon ?? 'point'" />
                  <span class="flex-1">{{ x.label | t }}</span>
                  @if (x.ours) {
                    <span class="size-[5px] rounded-full bg-coral" title="Shipkeep"></span>
                  }
                </a>
              </div>
            }
          </nav>
          <div class="flex min-w-0 flex-col gap-3.5">
            @let copy = sectionCopy();
            <div class="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div class="flex flex-wrap items-center gap-2.5">
                  <span class="sec-title">{{ copy.title | t }}</span>
                  @if (copy.ours) {
                    <span class="tag-ours">Shipkeep</span>
                  }
                  @if (sample()) {
                    <sk-preview-pill />
                  }
                </div>
                <div class="sec-desc max-w-[620px]">{{ copy.desc | t }}</div>
              </div>
              @if (!sample() && !ownSection()) {
                <a
                  class="btn btn-sm btn-primary"
                  [routerLink]="[]"
                  [queryParams]="{ tab: 'config', section: 'yml' }"
                  >{{ 'Edit shipkeep.yml' | t }}</a
                >
              }
            </div>
            @if (section() === 'yml') {
              <div class="legacy-form">
                <sk-configuration-editor [application]="current" [environment]="environment()" />
              </div>
            } @else if (section() === 'rollback') {
              <div class="legacy-form">
                <sk-release-history
                  [environment]="environment()"
                  [applicationId]="current.id"
                  [revision]="deployments.items().length"
                />
              </div>
            } @else if (section() === 'actions') {
              <sk-agent-actions
                [environment]="environment()"
                [applicationId]="current.id"
                [revision]="reloads()"
                [deploymentLabels]="deploymentLabels()"
              />
            } @else if (section() === 'danger') {
              <sk-application-danger
                [environment]="environment()"
                [application]="current"
                [running]="replicas.items().length > 0"
                [deploying]="!!active()"
                [startable]="!!startable()"
                [maintenance]="maintained()"
                [domain]="!!firstDomain()"
                (start)="startAgain()"
                (stopped)="refresh()"
                (maintenanceChanged)="refresh()"
                (deleted)="leave()"
              />
            } @else {
              @for (b of copy.blocks; track $index) {
                <sk-block [block]="b" [organizationId]="organizationId()" />
              }
            }
          </div>
        </div>

        <div
          id="panel-deployments"
          role="tabpanel"
          aria-labelledby="tab-deployments"
          [hidden]="tab() !== 'deployments'"
          class="flex flex-col gap-3.5"
        >
          @if (focus(); as d) {
            @let st = status(d.state, d.stop, d.maintenance);
            <div class="card p-5">
              <div class="mb-[18px] flex flex-wrap items-center justify-between gap-2.5">
                <div class="flex items-baseline gap-2.5">
                  <span class="text-[14px] font-medium">{{
                    title(d) | t: { release: releaseLabel(d) }
                  }}</span>
                  <span class="text-[12.5px]" [style.color]="st.color">{{ st.label | t }}</span>
                </div>
                <span class="flex items-center gap-3">
                  <span class="font-mono text-[11.5px] text-mute">{{
                    duration(d.startedAt, d.finishedAt)
                  }}</span>
                  <a class="btn btn-xs" [routerLink]="['deployments', d.id]">{{ 'Details' | t }}</a>
                </span>
              </div>
              <div class="grid grid-cols-6 gap-1.5 max-sm:grid-cols-3 max-sm:gap-y-4">
                @for (s of pipeline(); track s.label) {
                  <div class="flex min-w-0 flex-col gap-2.5">
                    <div class="h-1 rounded-full" [style.background]="s.bar"></div>
                    <div class="flex min-w-0 items-center gap-[7px]">
                      <span
                        class="size-[7px] shrink-0 rounded-full border-[1.5px]"
                        [style.background]="s.dot"
                        [style.border-color]="s.ring"
                      ></span>
                      <span class="truncate text-[12.5px]" [style.color]="s.fg">{{
                        s.label | t
                      }}</span>
                    </div>
                  </div>
                }
              </div>
              <div
                class="mt-4 min-h-[90px] rounded-[10px] border border-line bg-black px-3.5 py-3 font-mono text-[11.5px] leading-[1.7]"
              >
                <div>
                  <span class="text-dim3">{{ clock(d.startedAt) }} </span
                  ><span class="text-fg3">{{
                    requested(d) ??
                      ('{trigger} deployment started' | t: { trigger: (d.trigger | t) })
                  }}</span>
                </div>
                @if (d.build) {
                  <div>
                    <span class="text-dim3">· </span
                    ><span class="text-fg3">{{ 'with a build' | t }}</span>
                  </div>
                }
                @if (d.release) {
                  <div>
                    <span class="text-dim3">· </span
                    ><span class="text-fg3">{{ 'runs the release command' | t }}</span>
                  </div>
                }
                @if (d.finishedAt) {
                  <div>
                    <span class="text-dim3">{{ clock(d.finishedAt) }} </span
                    ><span [style.color]="st.color">{{ st.label | t }}</span>
                  </div>
                } @else {
                  <div>
                    <span class="text-dim3">{{ 'now' | t }} </span
                    ><span class="text-blue">{{ st.label | t }}…</span>
                  </div>
                }
                @if (d.error) {
                  <div class="text-red">{{ d.error | t }}</div>
                }
              </div>
            </div>
          }
          <section class="card pt-[18px] pb-1.5" aria-labelledby="deployments-title">
            <h2 id="deployments-title" class="px-5 pb-3 text-[14px] font-medium">
              {{ 'Deployments' | t }}
            </h2>
            @for (d of deployments.items(); track d.id) {
              @let st = status(d.state, d.stop, d.maintenance);
              <div
                class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,0.9fr)_minmax(0,0.8fr)] items-center gap-3 border-t border-line2 px-5 py-[11px] text-[13px] max-sm:grid-cols-2"
              >
                <span class="font-mono text-[11.5px] text-mute">{{ shortDate(d.startedAt) }}</span>
                <div class="min-w-0 truncate">
                  <a
                    class="font-mono text-[11.5px] text-fg2 hover:underline"
                    [routerLink]="['deployments', d.id]"
                    [attr.aria-label]="
                      'Open deployment {release}' | t: { release: releaseLabel(d) }
                    "
                    >{{ releaseLabel(d) }}</a
                  >
                  <!-- A long cause is cut by the row: the whole of it is in the title. -->
                  <span class="ml-2 text-fg3" [attr.title]="d.error ? (d.error | t) : null">{{
                    d.error ?? cause(d) | t
                  }}</span>
                </div>
                <span class="flex items-center gap-[7px] text-[12.5px]" [style.color]="st.color"
                  ><span class="dot" [style.background]="st.color"></span>{{ st.label | t }}</span
                >
                <span class="flex items-center justify-end gap-2 text-[12px] text-mute2">
                  {{ actor(d) }}
                  @if (canRollBack(d)) {
                    <button
                      class="btn btn-xs"
                      type="button"
                      [disabled]="runner.busy() || !!runner.cooldown() || !!active()"
                      (click)="rollback(d.id)"
                    >
                      {{ 'Roll back' | t }}
                    </button>
                  }
                </span>
              </div>
            } @empty {
              <div class="border-t border-line2 px-5 py-4 text-[13px] text-mute2">
                {{ 'Not deployed yet.' | t }}
              </div>
            }
            @if (deployments.items().length) {
              <p class="border-t border-line2 px-5 py-3 text-[12px] text-dim">
                {{
                  "Rolling back deploys that version's image and configuration again, without its release command. Database migrations are not undone."
                    | t
                }}
              </p>
            }
          </section>
        </div>

        <div
          id="panel-logs"
          role="tabpanel"
          aria-labelledby="tab-logs"
          [hidden]="tab() !== 'logs'"
          class="flex flex-col gap-3"
        >
          <sk-application-logs
            [environment]="environment()"
            [applicationId]="current.id"
            [active]="tab() === 'logs'"
          />
        </div>

        <div
          id="panel-terminal"
          role="tabpanel"
          aria-labelledby="tab-terminal"
          [hidden]="tab() !== 'terminal'"
          class="flex flex-col gap-3"
        >
          <sk-terminal
            [environment]="environment()"
            [applicationId]="current.id"
            [name]="current.name"
          />
        </div>

        <div
          id="panel-metrics"
          role="tabpanel"
          aria-labelledby="tab-metrics"
          [hidden]="tab() !== 'metrics'"
          class="flex flex-col gap-3"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <p class="text-[12.5px] text-mute">
              {{ 'Measured by the agents every 30 seconds, kept for 30 days.' | t }}
            </p>
            <div class="seg" role="group" [attr.aria-label]="'Period' | t">
              @for (r of metricsRanges; track r) {
                <button
                  type="button"
                  class="font-mono"
                  [attr.aria-pressed]="metricsRange() === r"
                  (click)="metricsRange.set(r)"
                >
                  {{ r }}
                </button>
              }
            </div>
          </div>
          @if (metricsFailed()) {
            <p class="card px-[18px] py-4 text-[13px] text-mute" role="status">
              {{ 'Metrics could not be read. They are tried again in 30 seconds.' | t }}
            </p>
          } @else if (metrics(); as m) {
            @if (!m.kept) {
              <p class="card px-[18px] py-4 text-[13px] text-mute" role="status">
                {{
                  'This installation keeps no metrics: its control plane has no metrics store.' | t
                }}
              </p>
            } @else {
              <div class="grid gap-3.5 md:grid-cols-2">
                <sk-metric-chart
                  label="CPU"
                  unit="cores"
                  [points]="m.cpu[0]?.points ?? []"
                  [from]="seconds(m.from)"
                  [to]="seconds(m.to)"
                  [step]="m.stepSeconds"
                />
                <sk-metric-chart
                  label="Memory"
                  unit="bytes"
                  [points]="m.memory[0]?.points ?? []"
                  [from]="seconds(m.from)"
                  [to]="seconds(m.to)"
                  [step]="m.stepSeconds"
                />
                <sk-metric-chart
                  label="Requests · 5xx in red"
                  unit="perSecond"
                  [points]="requests()"
                  [errors]="serverErrors()"
                  [from]="seconds(m.from)"
                  [to]="seconds(m.to)"
                  [step]="m.stepSeconds"
                />
                <sk-metric-chart
                  label="Response time · mean"
                  unit="seconds"
                  [points]="m.duration[0]?.points ?? []"
                  [from]="seconds(m.from)"
                  [to]="seconds(m.to)"
                  [step]="m.stepSeconds"
                />
              </div>
            }
          } @else if (tab() === 'metrics') {
            <p class="text-[12.5px] text-mute" role="status">{{ 'Loading…' | t }}</p>
          }
        </div>
      }
    </div>
  `,
})
export class ApplicationPage {
  private readonly api = inject(DeliveryApi);
  private readonly liveEvents = inject(LiveEvents);
  private readonly router = inject(Router);
  protected readonly runner = inject(MutationRunner);
  protected readonly shell = inject(ShellContext);
  protected readonly tab = signal('config');
  protected readonly tabs = computed((): readonly Tab[] => [
    { id: 'config', label: 'Configuration', icon: 'settings' },
    {
      id: 'deployments',
      label: 'Deployments',
      icon: 'rocket',
      count: this.deployments.items().length || null,
    },
    { id: 'logs', label: 'Logs', icon: 'file-text' },
    { id: 'terminal', label: 'Terminal', icon: 'terminal-2' },
    { id: 'metrics', label: 'Metrics', icon: 'chart-bar' },
  ]);
  protected readonly menu = APP_SECTIONS;
  protected readonly metricsRanges: readonly MetricsRange[] = ['1h', '24h', '7d'];
  protected readonly metricsRange = signal<MetricsRange>('1h');
  protected readonly metrics = signal<ApplicationMetrics | null>(null);
  protected readonly metricsFailed = signal(false);
  /** The application and period the metrics shown belong to. */
  private metricsKey: string | null = null;
  /** Requests per second of every status class, added together. */
  protected readonly requests = computed(() => sumSeries(this.metrics()?.requests ?? []));
  protected readonly serverErrors = computed(
    () =>
      this.metrics()?.requests.find((series) => series.labels['status'] === '5xx')?.points ?? [],
  );
  protected readonly seconds = (at: string): number => Date.parse(at) / 1000;
  protected readonly status = deploymentStatus;
  protected title(deployment: Deployment): string {
    return KIND_TITLE[deploymentKind(deployment)];
  }
  protected cause(deployment: Deployment): string {
    return KIND_CAUSE[deploymentKind(deployment)] ?? deployment.trigger;
  }
  /** The first line of a stop's or a maintenance change's log, translated. */
  protected requested(deployment: Deployment): string | null {
    const kind = deploymentKind(deployment);
    if (kind === 'deploy') return null;
    return this.i18n.t(
      kind === 'stop'
        ? 'stop requested'
        : kind === 'enter'
          ? 'maintenance requested'
          : 'end of maintenance requested',
    );
  }
  protected readonly duration = duration;
  protected readonly clock = clock;
  protected readonly shortDate = shortDate;
  private readonly query = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((q) => q.get('section'))),
  );
  protected readonly section = computed(() => {
    const wanted = this.query();
    return APP_SECTIONS.some((x) => x.k === wanted) ? (wanted as string) : 'general';
  });
  protected readonly sample = computed(() => SAMPLE_SECTIONS.has(this.section()));
  protected readonly ownSection = computed(() => OWN_SECTIONS.has(this.section()));
  /** A deployment opened from another section, such as an agent action. */
  private readonly wantedDeployment = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((q) => q.get('deployment'))),
  );
  /** Counts deployment reloads, so the Agent actions section reloads with them. */
  protected readonly reloads = signal(0);
  /** Deployments named by the release they ran (#3), as the Rollback section lists them. */
  protected readonly deploymentLabels = computed(() => {
    const numbers = new Map(this.releases().map((release) => [release.id, release.number]));
    return new Map(
      this.deployments.items().flatMap((d) => {
        const number = numbers.get(d.releaseId);
        return number === undefined ? [] : [[d.id, `#${String(number)}`] as const];
      }),
    );
  });
  private readonly secrets = signal<readonly SecretMetadata[]>([]);
  private readonly releases = signal<readonly Release[]>([]);
  private readonly environmentInfo = signal<Environment | null>(null);
  protected readonly sectionCopy = computed((): SectionCopy => {
    const key = this.section();
    if (key === 'yml')
      return {
        title: 'shipkeep.yml',
        ours: 1,
        desc: this.application()?.repository
          ? 'The configuration of this application, read from its repository at each push.'
          : 'The configuration of this application. Saving checks it against the schema and against changes made meanwhile.',
        blocks: [],
      };
    if (key === 'rollback')
      return {
        title: 'Rollback',
        desc: 'Previous images stay ready. Rolling back rebuilds nothing.',
        blocks: [],
      };
    if (key === 'actions')
      return {
        title: 'Agent actions',
        ours: 1,
        desc: 'The closed list of typed actions agents ran for this app. No free-form shell commands.',
        blocks: [],
      };
    if (key === 'danger')
      return {
        title: 'Danger zone',
        desc: 'Maintenance shows visitors a page while the replicas keep running. Stopping frees the servers and keeps everything else. Deleting cannot be undone.',
        blocks: [],
      };
    if (key in APP_SAMPLES) return APP_SAMPLES[key as keyof typeof APP_SAMPLES];
    const app = this.application();
    return (
      configSection(key, {
        config: app?.config ?? {},
        configSha: app?.configSha ?? '',
        release: this.releases().at(0),
        secrets: this.secrets(),
        domains: this.domains.items(),
        replicas: this.replicas.items(),
        now: this.drawnAt(),
      }) ?? { title: key, desc: '', blocks: [] }
    );
  });
  protected readonly environmentName = computed(() => this.environmentInfo()?.name ?? '…');
  protected readonly protectedEnvironment = computed(() => !!this.environmentInfo()?.protected);
  protected readonly firstDomain = computed(() => this.domains.items().at(0)?.hostname ?? null);
  protected readonly image = computed(() => {
    const build = (this.application()?.config as { build?: { image?: unknown } } | undefined)
      ?.build;
    return typeof build?.image === 'string' ? build.image : null;
  });
  protected readonly running = computed(
    () => this.replicas.items().filter((r) => r.state === 'running').length,
  );
  protected readonly headline = computed(() => {
    const latest = this.deployments.items().at(0);
    if (!latest) return null;
    const status = deploymentStatus(latest.state, latest.stop, latest.maintenance);
    // A succeeded deployment says live; the replicas say whether the application still runs.
    if (status.label !== 'live' || this.replicas.state() !== 'ready') return status;
    return servingStatus(this.running(), this.replicas.items().length);
  });
  /** The deployment the pipeline shows: the one asked for, the one running, or the latest. */
  protected readonly focus = computed(
    () =>
      this.deployments.items().find((d) => d.id === this.wantedDeployment()) ??
      this.active() ??
      this.deployments.items().at(0) ??
      null,
  );
  protected readonly pipeline = computed(() => {
    const d = this.focus();
    if (!d) return [];
    const done = d.state === 'succeeded' || d.state === 'rolled_back';
    const kind = deploymentKind(d);
    const steps = kind === 'stop' ? STOP_STEPS : kind === 'deploy' ? STEPS : MAINTENANCE_STEPS;
    const at = steps.findIndex((step) => step.states.includes(d.state));
    return steps.map((step, i) => {
      const past = done || (at >= 0 && i < at);
      const now = !done && i === at;
      const color = now ? BLUE : '#D6D6DC';
      const failedHere = d.state === 'failed' && i === 0;
      return {
        label: step.label,
        bar: past ? '#D6D6DC' : now ? color : failedHere ? RED : '#1E1E22',
        dot: past ? '#D6D6DC' : now ? color : 'transparent',
        ring: past ? '#D6D6DC' : now ? color : failedHere ? RED : '#3A3A42',
        fg: past || now ? '#EDEDEF' : '#7E7E87',
      };
    });
  });
  /** After a stop, the deployment to roll back to in order to start the application again. */
  protected readonly startable = computed(() => startTarget(this.deployments.items()));
  /** Visitors see the maintenance page: deploying waits until it is left (ADR 0025). */
  protected readonly maintained = computed(() => inMaintenance(this.deployments.items()));
  /** The version before the one serving now, offered as a one-click rollback. */
  protected readonly previous = computed(
    () => this.deployments.items().find((d) => this.canRollBack(d)) ?? null,
  );
  private readonly workspace = inject(WorkspaceApi);
  private readonly crumbs = inject(PageCrumbs);
  private readonly i18n = inject(I18n);
  protected readonly green = GREEN;
  protected readonly projectName = computed(
    () =>
      this.shell.projects().find((project) => project.id === this.projectId())?.name ?? 'Project',
  );
  readonly organizationId = input.required<string>();
  readonly projectId = input.required<string>();
  readonly environmentId = input.required<string>();
  readonly applicationId = input.required<string>();
  protected readonly environment = computed<EnvironmentRef>(() => ({
    organizationId: this.organizationId(),
    projectId: this.projectId(),
    environmentId: this.environmentId(),
  }));
  protected readonly application = signal<Application | null>(null);
  protected readonly missing = signal<string | null>(null);
  protected readonly deployments = new Collection<Deployment>(() =>
    this.api.deployments(this.environment(), this.applicationId()),
  );
  protected readonly replicas = new Collection<Replica>(() =>
    this.api.replicas(this.environment(), this.applicationId()),
  );
  protected readonly domains = new Collection<DomainStatus>(() =>
    this.api.domains(this.environment(), this.applicationId()),
  );
  protected readonly active = computed(() =>
    this.deployments.items().find((deployment) => !FINISHED.has(deployment.state)),
  );
  private timer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;
  private refreshAgain = false;
  private destroyed = false;
  /**
   * The load in force: a response to an earlier one, success or failure, is dropped, so another
   * application's or environment's data never shows under this one (issue #491).
   */
  private loadRevision = 0;
  /** Only the latest release list request answers: an older one never replaces a newer list. */
  private releasesRequest = 0;
  /** The environment and application whose data the page holds. */
  private loadedKey = '';
  /**
   * The time the sections are drawn at, moved on every minute: a certificate's days left change on
   * a page left open, even when no data does.
   */
  private readonly drawnAt = signal(new Date());

  constructor() {
    const ticking = setInterval(() => {
      this.drawnAt.set(new Date());
    }, 60_000);
    inject(DestroyRef).onDestroy(() => {
      ++this.loadRevision;
      this.destroyed = true;
      clearTimeout(this.timer);
      clearInterval(ticking);
    });
    // Metrics load while their tab is open, and again every 30 seconds, as the agents sample.
    effect((onCleanup) => {
      if (this.tab() !== 'metrics') return;
      const environment = this.environment();
      const applicationId = this.applicationId();
      const range = this.metricsRange();
      // Charts of another application or period are cleared at once, never shown under this one;
      // reopening the tab on the same ones keeps them until the next answer.
      const key = [environment.environmentId, applicationId, range].join('/');
      if (key !== this.metricsKey) {
        this.metricsKey = key;
        this.metrics.set(null);
        this.metricsFailed.set(false);
      }
      let stale = false;
      // Only the latest request may answer: a slow older one never replaces a newer answer.
      let latest = 0;
      const load = async () => {
        const request = ++latest;
        try {
          const answer = await this.api.metrics(environment, applicationId, range);
          if (stale || request !== latest) return;
          this.metrics.set(answer);
          this.metricsFailed.set(false);
        } catch {
          if (!stale && request === latest) this.metricsFailed.set(true);
        }
      };
      void load();
      const every = setInterval(() => {
        void load();
      }, 30_000);
      onCleanup(() => {
        stale = true;
        clearInterval(every);
      });
    });
    effect(() => {
      void this.load(this.environment(), this.applicationId());
    });
    effect(() => {
      const app = this.application();
      const env = this.environmentInfo();
      if (!app) return;
      this.crumbs.set([
        {
          label: this.projectName(),
          raw: true,
          link: ['/orgs', this.organizationId(), 'projects', this.projectId()],
        },
        {
          label: env?.name ?? '…',
          raw: true,
          link: [
            '/orgs',
            this.organizationId(),
            'projects',
            this.projectId(),
            'environments',
            this.environmentId(),
          ],
        },
        { label: app.name, raw: true },
      ]);
    });
    effect((onCleanup) => {
      const events = this.liveEvents.connect(
        this.environment(),
        (applicationId) => {
          if (applicationId === this.applicationId()) void this.refresh();
        },
        // Each time the stream opens, a hint sent while it was down is not replayed: reload.
        () => {
          void this.refresh();
        },
      );
      onCleanup(() => {
        events?.close();
      });
    });
  }

  private async load(environment: EnvironmentRef, applicationId: string): Promise<void> {
    const revision = ++this.loadRevision;
    const current = () => revision === this.loadRevision;
    this.application.set(null);
    this.missing.set(null);
    // Another application or environment: what was shown for the previous one goes at once.
    const key = `${environment.environmentId}/${applicationId}`;
    if (key !== this.loadedKey) {
      this.loadedKey = key;
      this.secrets.set([]);
      this.releases.set([]);
      this.environmentInfo.set(null);
    }
    try {
      const application = await this.api.application(environment, applicationId);
      if (!current()) return;
      this.application.set(application);
      void this.domains.refresh();
      void this.api
        .secrets(environment)
        .then((items) => {
          if (current()) this.secrets.set(items);
        })
        .catch(() => {
          if (current()) this.secrets.set([]);
        });
      this.loadReleases(environment, applicationId);
      void this.workspace
        .environment(environment.organizationId, environment.projectId, environment.environmentId)
        .then((env) => {
          if (current()) this.environmentInfo.set(env);
        })
        .catch(() => {
          if (current()) this.environmentInfo.set(null);
        });
      await this.refresh();
    } catch (error: unknown) {
      if (revision !== this.loadRevision) return;
      this.application.set(null);
      this.missing.set(
        error instanceof IdentityRequestError
          ? error.message
          : 'This application could not be loaded.',
      );
    }
  }

  private loadReleases(environment: EnvironmentRef, applicationId: string): void {
    const revision = this.loadRevision;
    const request = ++this.releasesRequest;
    const current = () => revision === this.loadRevision && request === this.releasesRequest;
    void this.api
      .releases(environment, applicationId)
      .then((items) => {
        if (current()) this.releases.set(items);
      })
      .catch(() => {
        if (current()) this.releases.set([]);
      });
  }

  /**
   * The number of the release a deployment ran (#3), as the agent actions and the deployment page
   * name it; the start of its id while the releases are not loaded, or for an older release.
   */
  protected releaseLabel(deployment: Deployment): string {
    return this.deploymentLabels().get(deployment.id) ?? deployment.releaseId.slice(0, 7);
  }

  protected actor(deployment: Deployment): string {
    const name = deployment.actorId ? this.shell.names().get(deployment.actorId) : undefined;
    return name ?? this.i18n.t(deployment.trigger);
  }

  /** Reloads the deployments, and keeps doing so while one is still running. */
  /** The application was deleted: back to its environment, where it no longer is listed. */
  protected leave(): void {
    void this.router.navigate([
      '/orgs',
      this.organizationId(),
      'projects',
      this.projectId(),
      'environments',
      this.environmentId(),
    ]);
  }

  protected async refresh(): Promise<void> {
    // One at a time: a call meanwhile asks for one more right after, never for two in parallel.
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    clearTimeout(this.timer);
    try {
      void this.replicas.refresh();
      await this.deployments.refresh();
      // A new deployment comes with a new release: its number names it in the Agent actions
      // section.
      const latest = this.deployments.items().at(0);
      if (latest && !this.releases().some((release) => release.id === latest.releaseId))
        this.loadReleases(this.environment(), this.applicationId());
      this.reloads.update((n) => n + 1);
    } finally {
      this.refreshing = false;
    }
    if (this.destroyed) return;
    if (this.refreshAgain) {
      this.refreshAgain = false;
      await this.refresh();
      return;
    }
    // While a deployment runs, often; otherwise slowly, in case a change hint was missed.
    const delay = this.active()
      ? this.liveEvents.connected()
        ? LIVE_POLL_MS
        : POLL_MS
      : IDLE_POLL_MS;
    this.timer = setTimeout(() => {
      void this.refresh();
    }, delay);
  }

  protected async deploy(): Promise<void> {
    this.again();
    const outcome = await this.runner.run({ deploy: this.applicationId() }, () =>
      this.api.deploy(this.environment(), this.applicationId()),
    );
    if (outcome.ok) await this.refresh();
  }

  protected describeDomain(domain: DomainStatus): string {
    switch (domain.status) {
      case 'public':
        return `points to ${domain.addresses.join(', ')}`;
      case 'private':
        return 'points to a private address, so it cannot get a certificate';
      case 'none':
        return 'no DNS record yet';
      default:
        return 'DNS lookup failed; try again later';
    }
  }

  /** Versions that ran, other than the one serving now (the latest success). */
  protected canRollBack(deployment: Deployment): boolean {
    // A stop or a maintenance change ran no version of its own: the deployment it stopped is the
    // one to go back to. In maintenance, the server refuses a rollback, as it refuses a deploy.
    if (!ranAVersion(deployment) || this.maintained()) return false;
    if (deployment.state !== 'succeeded' && deployment.state !== 'rolled_back') return false;
    const latest = this.deployments.items().find((item) => item.state === 'succeeded');
    // After a stop nothing serves, so every version that ran can be started again.
    return latest?.stop === true || deployment.releaseId !== latest?.releaseId;
  }

  /**
   * A click is a new attempt. The runner stays locked after a refusal (a 409, for a missing
   * secret or a deployment already running), and would otherwise ignore every later click until
   * the page is reloaded. A wait the server asked for is kept.
   */
  private again(): void {
    if (this.runner.restartRequired()) this.runner.reset();
  }

  protected async startAgain(): Promise<void> {
    const start = this.startable();
    if (start) await this.rollback(start.id);
  }

  protected async rollback(deploymentId: string): Promise<void> {
    this.again();
    const outcome = await this.runner.run({ rollback: deploymentId }, () =>
      this.api.rollback(this.environment(), this.applicationId(), deploymentId),
    );
    if (outcome.ok) await this.refresh();
  }

  protected async cancel(deploymentId: string): Promise<void> {
    this.again();
    const outcome = await this.runner.run({ cancel: deploymentId }, () =>
      this.api.cancel(this.environment(), this.applicationId(), deploymentId),
    );
    if (outcome.ok) await this.refresh();
  }
}
