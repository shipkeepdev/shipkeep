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
import { toSignal } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { PageCrumbs } from '../dashboard/page-crumbs';
import { IdentityRequestError } from '../identity/identity-api';
import { Icon } from '../shell/icon';
import { type IconName } from '../shell/icons';
import { I18n, LocalDate, T } from '../ui/i18n';
import { Notice } from '../ui/notice';

import { FleetApi, type FleetNode, type NodeReplicaList } from './fleet-api';
import { NodeMetricsPanel } from './node-metrics';
import { serverView, type Text } from './server-view';

interface ServerSection {
  readonly k: 'general' | 'agent' | 'resources';
  readonly label: string;
  readonly icon: IconName;
  readonly head?: string;
  readonly ours?: boolean;
}

const SECTIONS: readonly ServerSection[] = [
  { k: 'general', label: 'General', icon: 'adjustments', head: 'Server' },
  { k: 'agent', label: 'Agent', icon: 'plug-connected', ours: true },
  { k: 'resources', label: 'Resources', icon: 'box' },
];

/** How often the page reads the server again, as the servers list and the charts do. */
const REFRESH_MS = 30_000;

const COLUMNS =
  'grid-cols-[minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,0.5fr)_minmax(0,0.6fr)_minmax(0,0.9fr)]';

/** 12 Server (#264): one server's facts, agent and replicas, read from the API. */
@Component({
  selector: 'sk-server-page',
  imports: [Icon, LocalDate, NgTemplateOutlet, NodeMetricsPanel, RouterLink, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (state()) {
      @case ('loading') {
        <p role="status" class="text-[13px] text-mute2">{{ 'Loading…' | t }}</p>
      }
      @case ('missing') {
        <div class="page">
          <h1 class="page-title">{{ 'Server not found' | t }}</h1>
          <p class="text-[13px] text-mute2">
            {{ 'This server does not exist in this organization, or you cannot see it.' | t }}
          </p>
          <a class="btn btn-sm self-start" [routerLink]="['/orgs', organizationId(), 'servers']"
            ><sk-icon name="server-2" />{{ 'Servers' | t }}</a
          >
        </div>
      }
      @case ('failed') {
        <div class="page">
          <p role="alert" class="text-[13px] text-mute2">
            {{ 'This server could not be read.' | t }}
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
                  <h1 class="page-title">{{ v.name }}</h1>
                  <span class="pill" [style.color]="v.status.color"
                    ><span class="dot" [style.background]="v.status.color"></span
                    >{{ v.status.label | t }}</span
                  >
                  @if (v.agentVersion) {
                    <span class="pill">{{
                      'agent {version}' | t: { version: v.agentVersion }
                    }}</span>
                  }
                </div>
                @if (v.sub) {
                  <div class="mt-1.5 max-w-[720px] text-[13px] text-pretty text-mute2">
                    {{ v.sub }}
                  </div>
                }
              </div>
              <div class="flex flex-wrap gap-2.5">
                <button type="button" class="btn" (click)="notice.notYet('Terminal')">
                  <sk-icon name="terminal-2" />{{ 'Terminal' | t }}
                </button>
                <button type="button" class="btn" (click)="notice.notYet('Drain')">
                  <sk-icon name="player-pause" />{{ 'Drain' | t }}
                </button>
              </div>
            </div>

            <div class="grid items-start gap-7 md:grid-cols-[210px_minmax(0,1fr)]">
              <nav
                class="flex flex-col gap-0.5 max-md:flex-row max-md:overflow-x-auto md:sticky md:top-3"
                [attr.aria-label]="'Server' | t"
              >
                @for (x of sections; track x.k) {
                  <div class="flex shrink-0 flex-col">
                    @if (x.head) {
                      <div class="sidenav-head max-md:hidden">{{ x.head | t }}</div>
                    }
                    <a
                      class="sidenav-item max-md:whitespace-nowrap"
                      [routerLink]="[]"
                      [queryParams]="{ section: x.k }"
                      [attr.aria-current]="x.k === current() ? 'page' : null"
                    >
                      <sk-icon [name]="x.icon" />
                      <span class="flex-1">{{ x.label | t }}</span>
                      @if (x.ours) {
                        <span class="size-[5px] rounded-full bg-coral" title="Shipkeep"></span>
                      }
                    </a>
                  </div>
                }
              </nav>

              <div class="flex min-w-0 flex-col gap-4">
                @switch (current()) {
                  @case ('agent') {
                    <div>
                      <div class="flex items-center gap-2.5">
                        <h2 class="sec-title">{{ 'Shipkeep agent' | t }}</h2>
                        <span class="tag-ours">Shipkeep</span>
                      </div>
                      <p class="sec-desc">
                        {{
                          'The agent calls the control plane over outbound mTLS. No inbound port, no SSH key.'
                            | t
                        }}
                      </p>
                    </div>
                    <ng-container
                      *ngTemplateOutlet="stats; context: { $implicit: v.agent }"
                    ></ng-container>
                    <div class="note">
                      <sk-icon name="info-circle" class="text-mute" />
                      <span>{{
                        'The agent log is not shown here yet. Each application lists the actions its agent ran.'
                          | t
                      }}</span>
                    </div>
                  }
                  @case ('resources') {
                    <div>
                      <h2 class="sec-title">{{ 'Resources' | t }}</h2>
                      <p class="sec-desc">
                        {{ 'Replicas placed on this server, as its agent last reported them.' | t }}
                      </p>
                    </div>
                    <div class="card overflow-x-auto">
                      <div class="min-w-[640px]">
                        <div [class]="columns + ' grid-table th px-[18px] py-[11px]'">
                          <span>{{ 'Resource' | t }}</span
                          ><span>{{ 'Project' | t }}</span
                          ><span>{{ 'CPU' | t }}</span
                          ><span>{{ 'Memory' | t }}</span
                          ><span>{{ 'State' | t }}</span>
                        </div>
                        @for (r of v.rows; track r.id) {
                          <div
                            [class]="
                              columns +
                              ' grid-table relative border-t border-line2 px-[18px] py-3 text-[12.5px] hover:bg-hover'
                            "
                            [attr.title]="r.container"
                          >
                            <span class="flex min-w-0 items-center gap-2">
                              <sk-icon name="box" class="shrink-0 text-[15px] text-mute" />
                              <a
                                [routerLink]="r.link"
                                class="truncate after:absolute after:inset-0"
                                >{{ r.application }}</a
                              >
                              @if (r.replicaLabel) {
                                <span class="shrink-0 text-dim">{{ r.replicaLabel }}</span>
                              }
                            </span>
                            <span class="truncate text-fg3">{{ r.place }}</span>
                            <span>{{ r.cpu === null ? '—' : decimal(r.cpu) }}</span>
                            <span>{{ r.memory }}</span>
                            @if (r.status; as s) {
                              <span
                                class="flex items-center gap-[7px] text-[12.5px]"
                                [style.color]="s.color"
                                ><span class="dot" [style.background]="s.color"></span
                                >{{ s.label | t }}</span
                              >
                            } @else {
                              <span class="text-[12.5px] text-dim">{{
                                'not reported yet' | t
                              }}</span>
                            }
                          </div>
                        } @empty {
                          <p class="px-5 py-4 text-[13px] text-mute2">
                            {{ 'No replica runs on this server.' | t }}
                          </p>
                        }
                      </div>
                    </div>
                    @if (v.truncated) {
                      <div class="note note-warn">
                        <sk-icon name="alert-triangle" class="text-amber" />
                        <span>{{ 'Only the first 200 replicas are listed.' | t }}</span>
                      </div>
                    }
                  }
                  @default {
                    <h2 class="sec-title">{{ 'General' | t }}</h2>
                    <ng-container
                      *ngTemplateOutlet="stats; context: { $implicit: v.stats }"
                    ></ng-container>
                    <div class="card px-5 py-1.5">
                      @for (f of v.machine; track f.label) {
                        <div class="field-row">
                          <div class="field-label">{{ f.label | t }}</div>
                          <div
                            class="min-w-0 truncate text-[13px]"
                            [class.font-mono]="f.mono && f.value"
                            [class.text-dim]="!f.value"
                          >
                            {{ f.value ?? (f.none ?? 'Not reported' | t) }}
                          </div>
                        </div>
                      }
                      <div class="field-row">
                        <div class="field-label">{{ 'Enrolled' | t }}</div>
                        <div class="text-[13px]">
                          {{ node()?.createdAt | localDate: 'mediumDate' }}
                        </div>
                      </div>
                    </div>
                    <sk-node-metrics [organizationId]="organizationId()" [nodes]="nodes()" />
                  }
                }
              </div>
            </div>
          </div>

          <ng-template #stats let-items>
            <div class="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
              @for (k of items; track k.label) {
                <div class="rounded-[14px] border border-line bg-black px-4 py-3.5">
                  <div class="flex items-center gap-[7px] text-[12px] text-mute">
                    <sk-icon [name]="k.icon" class="text-[14px]" />{{ k.label | t }}
                  </div>
                  <div
                    class="mt-2 text-[24px] tracking-[-0.02em]"
                    [style.color]="k.color || '#EDEDEF'"
                  >
                    {{ say(k.value) }}
                  </div>
                  @if (k.sub) {
                    <div class="mt-0.5 text-[11.5px] text-dim">{{ say(k.sub) }}</div>
                  }
                </div>
              }
            </div>
          </ng-template>
        }
      }
    }
  `,
})
export class ServerPage {
  readonly organizationId = input.required<string>();
  readonly nodeId = input.required<string>();
  private readonly api = inject(FleetApi);
  private readonly i18n = inject(I18n);
  private readonly crumbs = inject(PageCrumbs);
  protected readonly notice = inject(Notice);
  protected readonly sections = SECTIONS;
  protected readonly columns = COLUMNS;
  private readonly section = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((params) => params.get('section'))),
  );
  protected readonly current = computed(
    () => SECTIONS.find((x) => x.k === this.section())?.k ?? 'general',
  );
  protected readonly node = signal<FleetNode | null>(null);
  private readonly replicas = signal<NodeReplicaList | null>(null);
  protected readonly state = signal<'loading' | 'ready' | 'missing' | 'failed'>('loading');
  private readonly now = signal(Date.now());
  protected readonly nodes = computed(() => {
    const node = this.node();
    return node ? [node] : [];
  });
  protected readonly view = computed(() => {
    const node = this.node();
    const replicas = this.replicas();
    return node && replicas ? serverView(this.organizationId(), node, replicas, this.now()) : null;
  });
  #revision = 0;

  constructor() {
    effect(() => {
      this.organizationId();
      this.nodeId();
      untracked(() => {
        this.node.set(null);
        this.replicas.set(null);
        this.state.set('loading');
        void this.load();
      });
    });
    effect(() => {
      const node = this.node();
      if (!node) return;
      untracked(() => {
        this.crumbs.set([
          { label: 'Servers', link: ['/orgs', this.organizationId(), 'servers'] },
          { label: node.name, raw: true },
        ]);
      });
    });
    const refresh = setInterval(() => {
      this.now.set(Date.now());
      if (this.state() === 'ready') void this.load();
    }, REFRESH_MS);
    const tick = setInterval(() => {
      this.now.set(Date.now());
    }, 5_000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(refresh);
      clearInterval(tick);
    });
  }

  /** Reads the server and what runs on it; a newer read wins over an older one. */
  protected async load(): Promise<void> {
    const revision = ++this.#revision;
    const organizationId = this.organizationId();
    const nodeId = this.nodeId();
    try {
      const [node, replicas] = await Promise.all([
        this.api.node(organizationId, nodeId),
        this.api.nodeReplicas(organizationId, nodeId),
      ]);
      if (revision !== this.#revision) return;
      this.node.set(node);
      this.replicas.set(replicas);
      this.state.set('ready');
    } catch (error: unknown) {
      if (revision !== this.#revision) return;
      // A server outside the organization and one the account may not see both answer 404.
      if (error instanceof IdentityRequestError && error.status === 404) this.state.set('missing');
      else if (this.state() !== 'ready') this.state.set('failed');
    }
  }

  protected say(text: Text): string {
    // Fractions, such as reserved cores, take the interface language's decimal mark.
    const values = text.values
      ? Object.fromEntries(
          Object.entries(text.values).map(([key, value]) => [
            key,
            typeof value === 'number' && !Number.isInteger(value) ? this.decimal(value) : value,
          ]),
        )
      : undefined;
    return text.count
      ? this.i18n.count(text.count.n, text.t, text.count.other, values)
      : this.i18n.t(text.t, values);
  }

  /** 0.25 in English, 0,25 in French: at most two decimals. */
  protected decimal(value: number): string {
    return value.toLocaleString(this.i18n.language() === 'fr' ? 'fr-FR' : 'en-US', {
      maximumFractionDigits: 2,
    });
  }
}
