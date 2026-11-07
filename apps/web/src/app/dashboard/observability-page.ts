import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';

import { Icon } from '../shell/icon';
import { T } from '../ui/i18n';
import { AMBER, RED } from './format';
import { PreviewPill } from './screen-view';

function spark(fn: (i: number) => number, n: number): string {
  const values = Array.from({ length: n }, (_, i) => fn(i));
  const max = Math.max(...values);
  const min = Math.min(...values);
  return `M${values
    .map(
      (y, i) =>
        `${((i / (n - 1)) * 100).toFixed(1)} ${(28 - ((y - min) / (max - min || 1)) * 24).toFixed(1)}`,
    )
    .join(' L')}`;
}

const LEVEL_COLOR: Record<string, string> = { ERR: RED, WRN: AMBER, INF: '#8B8B93' };
const LOGS = [
  ['10:41:07', 'INF', 'caddy', 'GET /factures/2026-1104 200 38 ms'],
  ['10:41:05', 'INF', 'alerting', 'rule “p95 > 800 ms” triggered · Slack #ops'],
  ['10:41:02', 'ERR', 'srv-ams-3', 'POST /factures 502 upstream timeout after 30 s'],
  ['10:41:02', 'WRN', 'api', 'pg pool saturated 20/20, waiting 4.1 s'],
  ['10:40:58', 'INF', 'api', 'PDF export of invoice F-2026-1188 in 212 ms'],
  ['10:40:51', 'WRN', 'api', 'slow query SELECT … FROM lignes 1.9 s'],
  ['10:40:44', 'INF', 'caddy', 'GET /healthz 200 2 ms'],
  ['10:40:40', 'ERR', 'srv-ams-3', 'POST /factures 502 upstream timeout after 30 s'],
  ['10:40:33', 'INF', 'api', 'Stripe webhook invoice.paid verified'],
  ['10:40:21', 'INF', 'caddy', 'GET /factures?page=3 200 61 ms'],
  ['10:40:12', 'INF', 'agent', 'metrics sent · 1,284 series'],
  ['10:40:02', 'WRN', 'api', 'expired JWT for client 4412'],
] as const;
const RULES = [
  ['p95 latency > 800 ms', 'p95(http_latency) > 800ms for 2m', 'triggered', RED],
  ['Suspect server', 'node.heartbeat_age > 15s', 'triggered', AMBER],
  ['Disk > 85%', 'node.disk_used_ratio > 0.85', 'ok', '#7E7E87'],
  ['Missed backup', 'backup.age > 26h', 'ok', '#7E7E87'],
  ['5xx rate > 2%', 'rate(http_5xx) / rate(http) > 0.02', 'ok', '#7E7E87'],
] as const;

/** 05 Observability: logs, metrics and alert rules. Not built yet: the design's sample. */
@Component({
  selector: 'sk-observability-page',
  imports: [Icon, PreviewPill, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div>
        <div class="flex flex-wrap items-center gap-3">
          <h1 class="page-title">{{ 'Observability' | t }}</h1>
          <sk-preview-pill />
        </div>
        <div class="page-sub">
          {{
            'Logs and metrics are kept for 30 days. Alerts go out by email, Slack or webhook.' | t
          }}
        </div>
      </div>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3.5">
        @for (m of metrics; track m.label) {
          <div class="card flex flex-col gap-3 p-[18px]">
            <div class="flex items-baseline justify-between">
              <span class="text-[13px] text-mute">{{ m.label | t }}</span
              ><span class="text-[22px] font-medium tracking-[-0.02em]">{{ m.value }}</span>
            </div>
            <svg
              viewBox="0 0 100 30"
              preserveAspectRatio="none"
              class="h-16 w-full overflow-visible"
              aria-hidden="true"
            >
              <path
                [attr.d]="m.d"
                fill="none"
                [attr.stroke]="m.c"
                stroke-width="1.4"
                vector-effect="non-scaling-stroke"
              />
              <path
                [attr.d]="m.th"
                fill="none"
                stroke="#3A3A42"
                stroke-width="1"
                stroke-dasharray="3 3"
                vector-effect="non-scaling-stroke"
              />
            </svg>
            <div class="text-[11.5px] text-dim">{{ m.sub | t }}</div>
          </div>
        }
      </div>
      <div class="flex flex-wrap items-start gap-3.5">
        <div class="card min-w-0 flex-[1.6_1_560px] overflow-hidden">
          <div class="flex flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-3">
            <div
              class="flex min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-[#24242a] bg-black px-2.5 py-2 font-mono text-[12px] text-fg2"
            >
              <sk-icon name="search" class="text-[14px] text-dim2" />app:api-facturation
              env:production
            </div>
            <div class="flex gap-1">
              @for (l of levels; track l.k) {
                <button
                  type="button"
                  class="rounded-[7px] border px-2.5 py-1.5 font-mono text-[11px]"
                  [style.border-color]="level() === l.k ? '#7B7B84' : '#24242A'"
                  [style.color]="level() === l.k ? '#EDEDEF' : '#7C7C85'"
                  (click)="level.set(l.k)"
                >
                  {{ l.label | t }}
                </button>
              }
            </div>
          </div>
          <div
            class="flex min-h-[320px] flex-col gap-1 px-4 py-3 font-mono text-[11.5px] leading-[1.6]"
          >
            @for (l of logs(); track $index) {
              <div class="grid grid-cols-[70px_34px_88px_minmax(0,1fr)] gap-2.5">
                <span class="text-dim3">{{ l[0] }}</span
                ><span [style.color]="color(l[1])">{{ l[1] }}</span>
                <span class="truncate text-dim">{{ l[2] }}</span
                ><span class="break-words text-[#B8B8C0]">{{ l[3] | t }}</span>
              </div>
            }
          </div>
        </div>
        <div class="card min-w-0 flex-[1_1_340px] pt-[18px] pb-1.5">
          <div class="flex items-center justify-between px-[18px] pb-2.5">
            <span class="card-title">{{ 'Alert rules' | t }}</span
            ><span class="text-[12px] text-mute">{{ 'Add' | t }}</span>
          </div>
          @for (r of rules; track r[0]) {
            <div
              class="grid grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-3 border-t border-line2 px-[18px] py-[11px]"
            >
              <span class="mt-[5px] size-[7px] rounded-full" [style.background]="r[3]"></span>
              <div class="min-w-0">
                <div class="text-[13px]">{{ r[0] | t }}</div>
                <div class="mt-[3px] font-mono text-[11px] text-dim">{{ r[1] }}</div>
              </div>
              <span class="text-[11.5px]" [style.color]="r[3]">{{ r[2] | t }}</span>
            </div>
          }
        </div>
      </div>
    </div>
  `,
})
export class ObservabilityPage {
  protected readonly metrics = [
    {
      label: 'CPU · api-facturation',
      value: '31 %',
      d: spark((i) => 40 + 18 * Math.sin(i * 0.4) + 8 * Math.sin(i * 1.7), 48),
      th: 'M0 6 L100 6',
      c: '#EDEDEF',
      sub: 'Average of the 3 replicas · threshold 85%',
    },
    {
      label: 'Memory',
      value: '631 MB',
      d: spark((i) => 60 + i * 0.3 + 4 * Math.sin(i * 0.9), 48),
      th: 'M0 4 L100 4',
      c: '#A6A6AE',
      sub: 'Limit 1 GiB per replica',
    },
    {
      label: 'p95 latency',
      value: '412 ms',
      d: spark((i) => 380 + (i > 36 && i < 42 ? 520 : 0) + 60 * Math.sin(i * 0.7), 48),
      th: 'M0 10 L100 10',
      c: RED,
      sub: 'Peak of 940 ms at 10:41 · alert sent',
    },
  ];
  protected readonly levels = [
    { k: 'all', label: 'All' },
    { k: 'ERR', label: 'ERR' },
    { k: 'WRN', label: 'WRN' },
  ];
  protected readonly rules = RULES;
  protected readonly level = signal('all');
  protected readonly logs = computed(() =>
    LOGS.filter((l) => this.level() === 'all' || l[1] === this.level()),
  );

  protected color(level: string): string {
    return LEVEL_COLOR[level] ?? '#8B8B93';
  }
}
