import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { Icon } from '../shell/icon';
import { ShellContext } from '../shell/shell-context';
import { T } from '../ui/i18n';
import { OverviewStore } from '../workspace/overview-store';
import { deploymentStatus, duration, shortDate } from './format';

const COLUMNS =
  'grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,0.9fr)]';

/** Every application of the organization, across projects and environments. */
@Component({
  selector: 'sk-applications-page',
  imports: [Icon, RouterLink, T],
  providers: [OverviewStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1 class="page-title">{{ 'Applications' | t }}</h1>
          <div class="page-sub">
            {{
              '{n} applications in {e} environments'
                | t: { n: store.applications().length, e: store.environmentCount() }
            }}
          </div>
        </div>
        <a class="btn btn-primary" [routerLink]="['/orgs', organizationId(), 'new']"
          ><sk-icon name="plus" />{{ 'New application' | t }}</a
        >
      </div>
      <div class="card overflow-x-auto">
        <div class="min-w-[720px]">
          <div
            [class]="
              columns + ' grid gap-3 border-b border-line px-5 py-2.5 text-[11.5px] text-dim2'
            "
          >
            <span>{{ 'Application' | t }}</span
            ><span>{{ 'Project · env.' | t }}</span
            ><span>{{ 'Image' | t }}</span
            ><span>{{ 'State' | t }}</span
            ><span class="text-right">{{ 'Last deployment' | t }}</span>
          </div>
          @if (store.loading()) {
            <p role="status" class="px-5 py-4 text-[13px] text-mute2">{{ 'Loading…' | t }}</p>
          } @else {
            @for (a of store.applications(); track a.id) {
              @let last = a.deployments.at(0);
              @let s = last ? status(last.state) : null;
              <div
                [class]="
                  columns +
                  ' relative grid items-center gap-3 border-b border-line2 px-5 py-[11px] text-[13px] hover:bg-hover'
                "
              >
                <span class="flex min-w-0 items-center gap-2.5"
                  ><sk-icon name="box" class="text-[16px] text-mute" /><a
                    [routerLink]="a.link"
                    class="truncate after:absolute after:inset-0"
                    >{{ a.name }}</a
                  ></span
                >
                <span class="truncate text-[12px] text-fg3"
                  >{{ a.project }} · {{ a.environment }}</span
                >
                <span class="truncate font-mono text-[11.5px] text-fg2">{{ a.image ?? '—' }}</span>
                @if (s) {
                  <span class="flex items-center gap-[7px] text-[12.5px]" [style.color]="s.color"
                    ><span class="dot" [style.background]="s.color"></span>{{ s.label | t }}</span
                  >
                } @else {
                  <span class="text-[12.5px] text-dim">{{ 'never deployed' | t }}</span>
                }
                <span class="text-right font-mono text-[11.5px] text-mute2">{{
                  last
                    ? shortDate(last.startedAt) + ' · ' + duration(last.startedAt, last.finishedAt)
                    : '—'
                }}</span>
              </div>
            } @empty {
              <div class="flex flex-col items-start gap-3 px-5 py-6">
                <p class="text-[13px] text-mute2">{{ 'No application yet.' | t }}</p>
                <a class="btn btn-sm" [routerLink]="['/orgs', organizationId(), 'new']"
                  ><sk-icon name="plus" />{{ 'New application' | t }}</a
                >
              </div>
            }
          }
        </div>
      </div>
    </div>
  `,
})
export class ApplicationsPage {
  protected readonly store = inject(OverviewStore);
  private readonly shell = inject(ShellContext);
  protected readonly organizationId = computed(() => this.shell.organizationId() ?? '');
  protected readonly columns = COLUMNS;
  protected readonly status = deploymentStatus;
  protected readonly duration = duration;
  protected readonly shortDate = shortDate;

  constructor() {
    effect(() => {
      const id = this.shell.organizationId();
      if (id) void this.store.load(id);
    });
  }
}
