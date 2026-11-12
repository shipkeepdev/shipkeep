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
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { BlockView } from '../dashboard/block-view';
import {
  clock,
  deploymentStatus,
  duration,
  shortDate,
  BLUE,
  GREEN,
  RED,
} from '../dashboard/format';
import { PageCrumbs } from '../dashboard/page-crumbs';
import { PreviewPill } from '../dashboard/screen-view';
import { Icon } from '../shell/icon';
import { Brand } from '../ui/brand';
import { I18n, T } from '../ui/i18n';
import { WorkspaceApi, type Environment } from '../workspace/workspace-api';

import { IdentityRequestError } from '../identity/identity-api';
import { MutationRunner } from '../identity/mutation-runner';
import { ShellContext } from '../shell/shell-context';
import { type Tab, Tabs } from '../shell/tabs';
import { Collection } from '../workspace/collection';

import {
  APP_SAMPLES,
  APP_SECTIONS,
  SAMPLE_CHARTS,
  SAMPLE_LOGS,
  SAMPLE_TERMINAL,
  type SectionCopy,
} from './application-design';
import { AgentActionsPanel } from './agent-actions-panel';
import { configSection } from './config-sections';
import { ConfigurationEditor } from './configuration-editor';
import { LiveEvents } from './live-events';
import { ReleaseHistory } from './release-history';
import {
  type Application,
  DeliveryApi,
  type Deployment,
  type DomainStatus,
  type EnvironmentRef,
  type Release,
  type Replica,
  type SecretMetadata,
} from './delivery-api';

const STEPS: readonly { label: string; states: readonly string[] }[] = [
  { label: 'Queued', states: ['queued'] },
  { label: 'Build', states: ['building', 'built'] },
  { label: 'Release', states: ['releasing'] },
  { label: 'Placement', states: ['scheduling', 'starting'] },
  { label: 'Health check', states: ['health_checking'] },
  { label: 'Switchover', states: ['switching', 'draining'] },
];
const SAMPLE_SECTIONS = new Set(['tasks', 'approvals', 'webhooks']);
/** Sections with their own content instead of configuration blocks. */
const OWN_SECTIONS = new Set(['yml', 'rollback', 'actions']);

const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'rolled_back']);
/** While a deployment runs, its state is refreshed this often. */
const POLL_MS = 3000;
/** With live updates, polling only covers an event the stream could miss. */
const LIVE_POLL_MS = 15_000;

/** One application: its configuration, deploying it and following its deployments. */
@Component({
  selector: 'sk-application-page',
  imports: [
    AgentActionsPanel,
    BlockView,
    Brand,
    ConfigurationEditor,
    Icon,
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
              '{n} of {m} replicas running' | t: { n: running(), m: replicas.items().length }
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
          } @else if (previous(); as prev) {
            <button
              class="btn"
              type="button"
              [disabled]="runner.busy() || !!runner.cooldown()"
              (click)="rollback(prev.id)"
            >
              <sk-icon name="arrow-back-up" />{{
                'Roll back to {release}' | t: { release: prev.releaseId.slice(0, 7) }
              }}
            </button>
          }
          <button
            class="btn btn-primary"
            type="button"
            [style.background]="active() ? '#8B8B93' : null"
            [disabled]="!current || runner.busy() || !!runner.cooldown() || !!active()"
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
            @let st = status(d.state);
            <div class="card p-5">
              <div class="mb-[18px] flex flex-wrap items-center justify-between gap-2.5">
                <div class="flex items-baseline gap-2.5">
                  <span class="text-[14px] font-medium">{{
                    'Deployment {release}' | t: { release: d.releaseId.slice(0, 7) }
                  }}</span>
                  <span class="text-[12.5px]" [style.color]="st.color">{{ st.label | t }}</span>
                </div>
                <span class="font-mono text-[11.5px] text-mute">{{
                  duration(d.startedAt, d.finishedAt)
                }}</span>
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
                    '{trigger} deployment started' | t: { trigger: (d.trigger | t) }
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
                  <div class="text-red">{{ d.error }}</div>
                }
              </div>
            </div>
          }
          <section class="card pt-[18px] pb-1.5" aria-labelledby="deployments-title">
            <h2 id="deployments-title" class="px-5 pb-3 text-[14px] font-medium">
              {{ 'Deployments' | t }}
            </h2>
            @for (d of deployments.items(); track d.id) {
              @let st = status(d.state);
              <div
                class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,0.9fr)_minmax(0,0.8fr)] items-center gap-3 border-t border-line2 px-5 py-[11px] text-[13px] max-sm:grid-cols-2"
              >
                <span class="font-mono text-[11.5px] text-mute">{{ shortDate(d.startedAt) }}</span>
                <div class="min-w-0 truncate">
                  <span class="font-mono text-[11.5px] text-fg2">{{
                    d.releaseId.slice(0, 7)
                  }}</span>
                  <span class="text-fg3">{{ d.error ?? (d.trigger | t) }}</span>
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
          <sk-preview-pill class="self-start" />
          <div class="card overflow-hidden">
            <div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
              @for (f of logFilters; track f.k) {
                <button
                  type="button"
                  class="rounded-lg border px-2.5 py-[5px] text-[12px]"
                  [style.border-color]="logFilter() === f.k ? '#EDEDEF' : '#262628'"
                  [style.color]="logFilter() === f.k ? '#EDEDEF' : '#8B8B93'"
                  (click)="logFilter.set(f.k)"
                >
                  {{ f.label | t }}
                </button>
              }
              <span class="ml-auto flex items-center gap-1.5 text-[12px] text-mute"
                ><span class="dot bg-green"></span>{{ 'live' | t }}</span
              >
            </div>
            <div class="max-h-[440px] overflow-auto px-4 py-3 font-mono text-[12px] leading-[1.85]">
              @for (l of logs(); track $index) {
                <div
                  class="grid grid-cols-[70px_78px_40px_minmax(0,1fr)] gap-2.5 whitespace-nowrap"
                >
                  <span class="text-dim3">{{ l.t }}</span
                  ><span class="text-dim">{{ l.node }}</span>
                  <span
                    [style.color]="
                      l.lvl === 'ERR'
                        ? 'oklch(0.68 0.17 25)'
                        : l.lvl === 'WRN'
                          ? 'oklch(0.80 0.12 80)'
                          : '#7E7E87'
                    "
                    >{{ l.lvl }}</span
                  >
                  <span class="truncate text-fg2">{{ l.msg | t }}</span>
                </div>
              }
            </div>
          </div>
        </div>

        <div
          id="panel-terminal"
          role="tabpanel"
          aria-labelledby="tab-terminal"
          [hidden]="tab() !== 'terminal'"
          class="flex flex-col gap-3"
        >
          <sk-preview-pill class="self-start" />
          <div class="note note-warn">
            <sk-icon name="shield-lock" class="text-amber" />
            <span>{{
              'Session recorded in the audit log. The terminal goes through the agent: no SSH port is open.'
                | t
            }}</span>
          </div>
          <div class="card overflow-hidden">
            <div
              class="flex items-center gap-2.5 border-b border-line px-4 py-2.5 font-mono text-[11.5px] text-mute"
            >
              <span class="text-fg">{{ current.name }}</span
              >/app<span class="ml-auto">{{ 'not connected' | t }}</span>
            </div>
            <div class="min-h-[260px] px-4 py-3.5 font-mono text-[12.5px] leading-[1.8]">
              @for (l of terminal; track $index) {
                <div class="whitespace-pre" [style.color]="l.c">{{ l.t | t }}</div>
              }
              <div class="flex gap-2">
                <span class="text-rose">$</span><span class="inline-block h-4 w-2 bg-fg"></span>
              </div>
            </div>
          </div>
        </div>

        <div
          id="panel-metrics"
          role="tabpanel"
          aria-labelledby="tab-metrics"
          [hidden]="tab() !== 'metrics'"
          class="flex flex-col gap-3"
        >
          <sk-preview-pill class="self-start" />
          <div class="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3.5">
            @for (c of charts; track c.label) {
              <div class="card px-[18px] py-4">
                <div class="flex items-baseline justify-between">
                  <span class="text-[13px] text-fg3">{{ c.label | t }}</span
                  ><span class="text-[20px] tracking-[-0.02em]">{{ c.v | t }}</span>
                </div>
                <div class="mt-3.5 flex h-[90px] items-end gap-[3px]">
                  @for (b of c.bars; track $index) {
                    <span
                      class="flex-1 rounded-t-[2px]"
                      [style.height]="b.h"
                      [style.background]="
                        b.hot ? 'oklch(0.68 0.17 25)' : b.last ? '#EDEDEF' : '#2A2A30'
                      "
                    ></span>
                  }
                </div>
              </div>
            }
          </div>
        </div>
      }
    </div>
  `,
})
export class ApplicationPage {
  private readonly api = inject(DeliveryApi);
  private readonly liveEvents = inject(LiveEvents);
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
  protected readonly terminal = SAMPLE_TERMINAL;
  protected readonly charts = SAMPLE_CHARTS;
  protected readonly status = deploymentStatus;
  protected readonly duration = duration;
  protected readonly clock = clock;
  protected readonly shortDate = shortDate;
  protected readonly logFilter = signal('all');
  protected readonly logFilters = [
    { k: 'all', label: 'All' },
    { k: 'err', label: 'Errors' },
    { k: 'srv-par-1', label: 'srv-par-1' },
    { k: 'srv-fra-2', label: 'srv-fra-2' },
  ];
  protected readonly logs = computed(() =>
    SAMPLE_LOGS.filter((l) => {
      const f = this.logFilter();
      return f === 'all' || (f === 'err' ? l.lvl !== 'INF' : l.node === f);
    }),
  );
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
        desc: 'The configuration of this application. Saving checks it against the schema and against changes made meanwhile.',
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
    return latest ? deploymentStatus(latest.state) : null;
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
    const at = STEPS.findIndex((step) => step.states.includes(d.state));
    return STEPS.map((step, i) => {
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
  private loadRevision = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      ++this.loadRevision;
      clearTimeout(this.timer);
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
      const events = this.liveEvents.connect(this.environment(), (applicationId) => {
        if (applicationId === this.applicationId()) void this.refresh();
      });
      onCleanup(() => {
        events?.close();
      });
    });
  }

  private async load(environment: EnvironmentRef, applicationId: string): Promise<void> {
    const revision = ++this.loadRevision;
    this.application.set(null);
    this.missing.set(null);
    try {
      const application = await this.api.application(environment, applicationId);
      if (revision !== this.loadRevision) return;
      this.application.set(application);
      void this.domains.refresh();
      void this.api
        .secrets(environment)
        .then((items) => {
          this.secrets.set(items);
        })
        .catch(() => {
          this.secrets.set([]);
        });
      this.loadReleases(environment, applicationId);
      void this.workspace
        .environment(environment.organizationId, environment.projectId, environment.environmentId)
        .then((env) => {
          this.environmentInfo.set(env);
        })
        .catch(() => {
          this.environmentInfo.set(null);
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
    void this.api
      .releases(environment, applicationId)
      .then((items) => {
        this.releases.set(items);
      })
      .catch(() => {
        this.releases.set([]);
      });
  }

  protected actor(deployment: Deployment): string {
    const email = deployment.actorId ? this.shell.emails().get(deployment.actorId) : undefined;
    return email ?? this.i18n.t(deployment.trigger);
  }

  /** Reloads the deployments, and keeps doing so while one is still running. */
  private async refresh(): Promise<void> {
    clearTimeout(this.timer);
    void this.replicas.refresh();
    await this.deployments.refresh();
    // A new deployment comes with a new release: its number names it in the Agent actions section.
    const latest = this.deployments.items().at(0);
    if (latest && !this.releases().some((release) => release.id === latest.releaseId))
      this.loadReleases(this.environment(), this.applicationId());
    this.reloads.update((n) => n + 1);
    if (this.active())
      this.timer = setTimeout(
        () => {
          void this.refresh();
        },
        this.liveEvents.connected() ? LIVE_POLL_MS : POLL_MS,
      );
  }

  protected async deploy(): Promise<void> {
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
    if (deployment.state !== 'succeeded' && deployment.state !== 'rolled_back') return false;
    const serving = this.deployments.items().find((item) => item.state === 'succeeded');
    return deployment.releaseId !== serving?.releaseId;
  }

  protected async rollback(deploymentId: string): Promise<void> {
    const outcome = await this.runner.run({ rollback: deploymentId }, () =>
      this.api.rollback(this.environment(), this.applicationId(), deploymentId),
    );
    if (outcome.ok) await this.refresh();
  }

  protected async cancel(deploymentId: string): Promise<void> {
    const outcome = await this.runner.run({ cancel: deploymentId }, () =>
      this.api.cancel(this.environment(), this.applicationId(), deploymentId),
    );
    if (outcome.ok) await this.refresh();
  }
}
