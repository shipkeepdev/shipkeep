import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { Icon } from '../shell/icon';
import { T } from '../ui/i18n';
import { Notice } from '../ui/notice';
import { AMBER, BLUE, GREEN } from './format';
import { PreviewPill } from './screen-view';

const SAMPLES = [
  {
    pr: 214,
    title: 'New invoices table',
    app: 'front-lumen',
    branch: 'feat/tableau-factures',
    url: 'pr-214.lumen.app',
    pct: 62,
    db: 'cloned database',
    author: 'Inès L.',
    state: 'live',
    color: GREEN,
  },
  {
    pr: 209,
    title: 'Filter by client',
    app: 'api-facturation',
    branch: 'feat/filtre-client',
    url: 'pr-209.lumen.app',
    pct: 18,
    db: 'empty database',
    author: 'Marc D.',
    state: 'live',
    color: GREEN,
  },
  {
    pr: 88,
    title: 'Cart redesign',
    app: 'shop-verdi',
    branch: 'refonte/panier',
    url: 'pr-88.verdi.shop',
    pct: 85,
    db: 'cloned database',
    author: 'Samuel M.',
    state: 'build',
    color: BLUE,
  },
  {
    pr: 41,
    title: 'Team page',
    app: 'site-vitrine',
    branch: 'page/equipe',
    url: 'pr-41.atelier-nord.fr',
    pct: 6,
    db: 'no database',
    author: 'Inès L.',
    state: 'expires soon',
    color: AMBER,
  },
];

/** 07 Previews: one environment per pull request. Not built yet, so it shows the design's sample. */
@Component({
  selector: 'sk-previews-page',
  imports: [Icon, PreviewPill, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="flex flex-wrap items-center gap-3">
            <h1 class="page-title">{{ 'Previews' | t }}</h1>
            <sk-preview-pill />
          </div>
          <div class="page-sub">
            {{
              'One environment per pull request, with lifetime, quota and an empty or cloned database. Deleted on merge.'
                | t
            }}
          </div>
        </div>
        <div class="flex gap-2.5 text-[12.5px] text-fg3">
          <span class="flex items-center gap-1.5 rounded-full border border-ctl2 px-3 py-[7px]"
            ><sk-icon name="hourglass" class="text-[14px]" />{{ 'Default TTL 3 d' | t }}</span
          >
          <span class="flex items-center gap-1.5 rounded-full border border-ctl2 px-3 py-[7px]"
            ><sk-icon name="gauge" class="text-[14px]" />{{
              '{n} / 8 active' | t: { n: previews().length }
            }}</span
          >
        </div>
      </div>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-3.5">
        @for (p of previews(); track p.pr) {
          <div class="card flex flex-col gap-3.5 p-[18px]">
            <div class="flex items-start justify-between gap-2.5">
              <div class="min-w-0">
                <div class="flex items-center gap-[7px] text-[14px] font-medium">
                  <sk-icon name="git-pull-request" class="text-[16px] text-fg3" />#{{ p.pr }}
                  {{ p.title | t }}
                </div>
                <div class="mt-1 text-[12px] text-dim">{{ p.app }} · {{ p.branch }}</div>
              </div>
              <span
                class="flex items-center gap-1.5 text-[11.5px] whitespace-nowrap"
                [style.color]="p.color"
                ><span class="dot" [style.background]="p.color"></span>{{ p.state | t }}</span
              >
            </div>
            <div
              class="flex items-center gap-2 rounded-[9px] border border-line bg-black px-2.5 py-2 font-mono text-[12px] text-fg2"
            >
              <sk-icon name="world" class="text-[14px] text-dim" /><span
                class="min-w-0 flex-1 truncate"
                >{{ p.url }}</span
              ><sk-icon name="external-link" class="text-[14px] text-dim" />
            </div>
            <div class="flex flex-col gap-1.5">
              <div class="flex justify-between text-[11.5px] text-mute">
                <span>{{ 'Remaining lifetime' | t }}</span
                ><span class="font-mono text-fg2">{{ p.ttl }}</span>
              </div>
              <div class="h-[5px] overflow-hidden rounded-full bg-track">
                <div
                  class="h-full rounded-full"
                  [style.width.%]="p.left"
                  [style.background]="p.left < 15 ? amber : '#C8C8CF'"
                ></div>
              </div>
            </div>
            <div class="flex flex-wrap gap-1.5 text-[11px] text-fg3">
              <span class="flex items-center gap-[5px] rounded-md bg-chip px-2 py-1"
                ><sk-icon name="database" class="text-[12px]" />{{ p.db | t }}</span
              >
              <span class="flex items-center gap-[5px] rounded-md bg-chip px-2 py-1"
                ><sk-icon name="cpu" class="text-[12px]" />1 CPU · 1 GiB</span
              >
              <span class="flex items-center gap-[5px] rounded-md bg-chip px-2 py-1"
                ><sk-icon name="user" class="text-[12px]" />{{ p.author }}</span
              >
            </div>
            <div class="flex gap-2 border-t border-line pt-3">
              <button type="button" class="btn btn-sm px-3 py-1.5" (click)="extend(p.pr)">
                <sk-icon name="clock-plus" />{{ 'Extend by 1 d' | t }}
              </button>
              <button
                type="button"
                class="btn btn-sm px-3 py-1.5"
                (click)="notice.notYet('Previews')"
              >
                <sk-icon name="trash" />{{ 'Delete' | t }}
              </button>
            </div>
          </div>
        }
      </div>
    </div>
  `,
})
export class PreviewsPage {
  protected readonly notice = inject(Notice);
  protected readonly amber = AMBER;
  private readonly extra = signal<Readonly<Record<number, number>>>({});
  protected readonly previews = computed(() =>
    SAMPLES.map((p) => {
      const left = Math.min(100, p.pct + (this.extra()[p.pr] ?? 0) * 33);
      const hours = Math.round((72 * left) / 100);
      return { ...p, left, ttl: `${String(Math.floor(hours / 24))} d ${String(hours % 24)} h` };
    }),
  );

  protected extend(pr: number): void {
    this.extra.update((all) => ({ ...all, [pr]: (all[pr] ?? 0) + 1 }));
  }
}
