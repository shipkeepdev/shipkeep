import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { Icon } from '../shell/icon';
import type { IconName } from '../shell/icons';

import { OverviewStore } from './overview-store';

interface Stat {
  readonly label: string;
  readonly icon: IconName;
  readonly value: number;
  readonly of: number | null;
  readonly note: string;
  readonly alert: string;
}

/** The first thing an organization sees: what runs, what is wrong, and what to do next. */
@Component({
  selector: 'sk-organization-overview',
  imports: [DatePipe, RouterLink, Icon],
  providers: [OverviewStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.nodes()?.length === 0) {
      <div class="next-step" role="status">
        <sk-icon name="alert-triangle" class="text-lg text-warning" />
        <p class="min-w-0 flex-1">
          <strong class="font-medium">No server connected yet.</strong>
          Deployments cannot run until one is.
        </p>
        <a class="button" [routerLink]="['/orgs', organizationId(), 'nodes']">
          <sk-icon name="server-2" />Add a server
        </a>
      </div>
    }
    <ul class="stat-grid" aria-label="Summary">
      @for (stat of stats(); track stat.label) {
        <li class="card">
          <div class="flex items-center gap-2.5 text-[13px] text-muted">
            <span class="icon-tile"><sk-icon [name]="stat.icon" /></span>
            <span class="min-w-0 flex-1">{{ stat.label }}</span>
            @if (stat.alert) {
              <span class="text-danger">{{ stat.alert }}</span>
            }
          </div>
          <p class="mt-3 text-[32px] leading-none font-medium tracking-tight tabular-nums">
            {{ stat.value }}
            @if (stat.of !== null) {
              <span class="text-sm font-normal tracking-normal text-muted">/ {{ stat.of }}</span>
            }
          </p>
          <p class="mt-3 text-[12.5px] text-muted">{{ stat.note }}</p>
        </li>
      }
    </ul>
    <div class="overview-columns">
      <section class="card p-0" aria-labelledby="recent-title">
        <div class="card-header">
          <h2 id="recent-title" class="mb-0">Recent deployments</h2>
        </div>
        @if (store.recent().length) {
          <div
            class="overflow-x-auto"
            role="region"
            aria-label="Scrollable table of recent deployments"
            tabindex="0"
          >
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">Application</th>
                  <th scope="col">Environment</th>
                  <th scope="col">State</th>
                  <th scope="col">Started</th>
                </tr>
              </thead>
              <tbody>
                @for (row of store.recent(); track row.deployment.id) {
                  <tr>
                    <td>
                      <a [routerLink]="row.application.link">{{ row.application.name }}</a>
                      <span class="block text-[12px] text-muted">{{
                        row.application.project
                      }}</span>
                    </td>
                    <td>{{ row.application.environment }}</td>
                    <td>
                      <span class="state" [class]="stateClass(row.deployment.state)">
                        {{ row.deployment.state }}
                      </span>
                      @if (row.deployment.error; as error) {
                        <span class="block max-w-xs text-[12px] text-muted">{{ error }}</span>
                      }
                    </td>
                    <td class="whitespace-nowrap text-muted tabular-nums">
                      {{ row.deployment.startedAt | date: 'MMM d, HH:mm' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (!store.loading()) {
          <p class="px-5 pb-5 text-[13.5px] text-muted">
            Nothing deployed yet. Open a project, then an environment, to create an application.
          </p>
        }
      </section>
      <div class="grid content-start gap-4">
        @if (store.nodes(); as nodes) {
          <section class="card p-0" aria-labelledby="servers-title">
            <div class="card-header">
              <h2 id="servers-title" class="mb-0">Servers</h2>
              <a class="text-[13px]" [routerLink]="['/orgs', organizationId(), 'nodes']">Manage</a>
            </div>
            @if (nodes.length) {
              <ul class="grid gap-2 px-5 pb-5">
                @for (node of nodes; track node.id) {
                  <li class="server-row">
                    <span class="truncate font-mono text-[13px]">{{ node.name }}</span>
                    <span class="state" [class]="stateClass(node.status)">{{ node.status }}</span>
                  </li>
                }
              </ul>
            } @else {
              <p class="px-5 pb-5 text-[13.5px] text-muted">None yet.</p>
            }
          </section>
        }
        @if (store.events(); as events) {
          <section class="card p-0" aria-labelledby="activity-title">
            <div class="card-header">
              <h2 id="activity-title" class="mb-0">Recent activity</h2>
              <a class="text-[13px]" [routerLink]="['/orgs', organizationId(), 'audit']"
                >View all</a
              >
            </div>
            <ul class="grid gap-3 px-5 pb-5">
              @for (event of events; track event.id) {
                <li class="flex items-baseline justify-between gap-3 text-[13px]">
                  <code class="min-w-0 truncate font-mono text-[12.5px]">{{ event.action }}</code>
                  <span class="shrink-0 text-[12px] text-muted tabular-nums">{{
                    event.createdAt | date: 'MMM d, HH:mm'
                  }}</span>
                </li>
              }
            </ul>
          </section>
        }
      </div>
    </div>
  `,
})
export class OrganizationOverview {
  protected readonly store = inject(OverviewStore);
  readonly organizationId = input.required<string>();

  constructor() {
    effect(() => {
      void this.store.load(this.organizationId());
    });
  }

  protected stats(): readonly Stat[] {
    const store = this.store;
    const applications = store.applications();
    const nodes = store.nodes();
    const failing = store.failing();
    return [
      {
        label: 'Applications',
        icon: 'apps',
        value: applications.length,
        of: null,
        note: `In ${String(store.environmentCount())} environments`,
        alert: failing ? `${String(failing)} failing` : '',
      },
      {
        label: 'Servers ready',
        icon: 'server-2',
        value: store.readyNodes(),
        of: nodes ? nodes.length : null,
        note: nodes ? 'Connected over outbound mTLS' : 'Visible to administrators',
        alert: '',
      },
      {
        label: 'Recent deployments',
        icon: 'rocket',
        value: store.recent().length,
        of: null,
        note: 'Across every application',
        alert: '',
      },
      {
        label: 'Projects',
        icon: 'folder',
        value: store.projectCount(),
        of: null,
        note: 'Each groups the environments of a product',
        alert: '',
      },
    ];
  }

  protected stateClass(state: string): string {
    if (state === 'succeeded' || state === 'ready') return 'state state-good';
    if (state === 'failed' || state === 'down' || state === 'cancelled') return 'state state-bad';
    return 'state state-busy';
  }
}
