import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';

import { PagedList } from '../access/paged-list';
import { Icon } from '../shell/icon';
import { T } from '../ui/i18n';

import { agentActionRow, timestamp } from './agent-action-rows';
import {
  AGENT_ACTION_PAGE,
  type AgentAction,
  DeliveryApi,
  type EnvironmentRef,
} from './delivery-api';

const COLUMNS =
  'sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1.3fr)_minmax(0,0.6fr)]';

/** The typed actions agents ran for an application, newest first (issue #263). */
@Component({
  selector: 'sk-agent-actions',
  imports: [Icon, NgTemplateOutlet, RouterLink, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-3' },
  template: `
    @if (actions.state() === 'failed') {
      <div class="alert flex flex-wrap items-center justify-between gap-3" role="alert">
        <span>{{ actions.problem() | t }}</span>
        <button class="btn btn-sm" type="button" (click)="actions.refresh()">
          {{ 'Retry' | t }}
        </button>
      </div>
    } @else {
      <div class="card">
        <div role="table" [attr.aria-label]="'Agent actions' | t">
          <div role="row" [class]="columns + ' grid-table th px-[18px] py-[11px] max-sm:hidden'">
            <span role="columnheader">{{ 'Time' | t }}</span>
            <span role="columnheader">{{ 'Action' | t }}</span>
            <span role="columnheader">{{ 'Server' | t }}</span>
            <span role="columnheader">{{ 'Result' | t }}</span>
            <span role="columnheader" class="text-right">{{ 'Deployment' | t }}</span>
          </div>
          @for (row of rows(); track row.id; let first = $first) {
            <div
              role="row"
              [class]="
                columns +
                ' grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-t border-line2 px-[18px] py-3 text-[12.5px]'
              "
              [class.max-sm:border-t-0]="first"
            >
              <span role="cell" class="order-2 text-right sm:order-none sm:text-left"
                ><time class="font-mono text-[11.5px] text-mute" [attr.datetime]="row.at">{{
                  stamp(row.at)
                }}</time></span
              >
              <span role="cell" class="order-1 min-w-0 break-all font-mono text-fg sm:order-none">{{
                row.action
              }}</span>
              <span role="cell" class="order-3 truncate font-mono text-fg3 sm:order-none"
                >{{ row.server }}
                <!-- On phones the deployment follows the server; its own column is hidden. -->
                @if (row.deploymentId; as deployment) {
                  <span class="sm:hidden"
                    >· <ng-container *ngTemplateOutlet="link; context: { $implicit: deployment }"
                  /></span>
                }
              </span>
              <span
                role="cell"
                class="order-4 flex min-w-0 items-center justify-end gap-[7px] sm:order-none sm:justify-start"
                [style.color]="row.result.color"
                ><span class="dot shrink-0" [style.background]="row.result.color"></span
                ><span class="min-w-0 break-words"
                  >{{ row.result.label | t: row.values }}
                  @if (row.reason) {
                    · {{ row.reason | t }}
                  }
                </span></span
              >
              <span role="cell" class="text-right font-mono text-[11.5px] max-sm:hidden">
                @if (row.deploymentId; as deployment) {
                  <ng-container *ngTemplateOutlet="link; context: { $implicit: deployment }" />
                }
              </span>
            </div>
          }
        </div>
        <ng-template #link let-deployment>
          <!-- Only deployments the page has loaded can be opened; older ones show their id. -->
          @if (deploymentLabels().has(deployment)) {
            <a
              class="font-mono text-[11.5px] text-mute underline-offset-2 hover:text-fg hover:underline"
              [routerLink]="[]"
              [queryParams]="{ tab: 'deployments', deployment: deployment }"
              [attr.aria-label]="'Deployment {id}' | t: { id: label(deployment) }"
              >{{ label(deployment) }}</a
            >
          } @else {
            <span
              class="font-mono text-[11.5px] text-mute2"
              [attr.aria-label]="'Deployment {id}' | t: { id: label(deployment) }"
              >{{ label(deployment) }}</span
            >
          }
        </ng-template>
        @if (!rows().length) {
          @if (actions.state() === 'loading') {
            <p
              role="status"
              class="border-t border-line2 px-[18px] py-4 text-[13px] text-mute2 max-sm:border-t-0"
            >
              {{ 'Loading…' | t }}
            </p>
          } @else {
            <p
              class="flex items-center gap-2 border-t border-line2 px-[18px] py-6 text-[13px] text-mute2 max-sm:border-t-0"
            >
              <sk-icon name="list-check" class="text-[15px]" />{{
                'No agent action yet. They appear here once a deployment runs.' | t
              }}
            </p>
          }
        }
      </div>
      @if (actions.problem() && actions.state() === 'ready') {
        <div class="alert" role="alert">{{ actions.problem() | t }}</div>
      }
      @if (actions.hasMore()) {
        <div>
          <button
            class="btn btn-sm"
            type="button"
            [disabled]="actions.loadingMore()"
            (click)="actions.more()"
          >
            {{ (actions.loadingMore() ? 'Loading…' : 'Load older actions') | t }}
          </button>
        </div>
      }
    }
  `,
})
export class AgentActionsPanel {
  private readonly api = inject(DeliveryApi);
  readonly environment = input.required<EnvironmentRef>();
  readonly applicationId = input.required<string>();
  /** Changes whenever the page reloads its deployments, so new actions show up. */
  readonly revision = input.required<number>();
  /** Names of the application's deployments, by id; others show the end of their id. */
  readonly deploymentLabels = input<ReadonlyMap<string, string>>(new Map());
  protected readonly columns = COLUMNS;
  protected readonly stamp = timestamp;
  protected readonly actions = new PagedList<AgentAction>((cursor) =>
    this.api.agentActions(this.environment(), this.applicationId(), cursor),
  );
  protected readonly rows = computed(() => this.actions.items().map(agentActionRow));

  private shown = '';

  constructor() {
    effect(() => {
      const { organizationId, projectId, environmentId } = this.environment();
      const key = [organizationId, projectId, environmentId, this.applicationId()].join('/');
      this.revision();
      // On the same application, older pages the user opened stay: only the newest is reloaded.
      const opened = untracked(() => this.actions.items().length) > AGENT_ACTION_PAGE;
      if (key !== this.shown || !opened) void this.actions.refresh();
      else void this.actions.refreshFirst((action) => action.id);
      this.shown = key;
    });
  }

  protected label(deploymentId: string): string {
    // UUIDv7 ids share their time prefix; the random end tells deployments apart.
    return this.deploymentLabels().get(deploymentId) ?? deploymentId.slice(-6);
  }
}
