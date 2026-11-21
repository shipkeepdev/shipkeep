import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';

import type { MetricsRange } from '../delivery/delivery-api';
import { formatMetric, MetricChart, type MetricPoint } from '../delivery/metric-chart';
import { I18n, T } from '../ui/i18n';

import { FleetApi, type FleetNode, type NodeMetrics } from './fleet-api';

/**
 * Charts of one server of the list (ADR 0024): CPU, memory and disk against what the server has,
 * and network traffic in and out. They load while the page is open, and again every 30 seconds,
 * as the agents sample.
 */
@Component({
  selector: 'sk-node-metrics',
  imports: [MetricChart, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="flex flex-col gap-3" aria-labelledby="node-metrics-title">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <h2 id="node-metrics-title" class="text-[15px] font-medium">{{ 'Metrics' | t }}</h2>
          @if (nodes().length > 1) {
            <label class="sr-only" for="node-metrics-server">{{ 'Server' | t }}</label>
            <select
              id="node-metrics-server"
              class="rounded-lg border border-ctl bg-black px-2 py-1 font-mono text-[12.5px] text-fg2"
              [value]="current()?.id ?? ''"
              (change)="pick($any($event.target).value)"
            >
              @for (n of nodes(); track n.id) {
                <option [value]="n.id">{{ n.name }}</option>
              }
            </select>
          } @else if (current(); as n) {
            <span class="font-mono text-[12.5px] text-fg3">{{ n.name }}</span>
          }
        </div>
        <div class="seg" role="group" [attr.aria-label]="'Period' | t">
          @for (r of ranges; track r) {
            <button
              type="button"
              class="font-mono"
              [attr.aria-pressed]="range() === r"
              (click)="range.set(r)"
            >
              {{ r }}
            </button>
          }
        </div>
      </div>
      @if (failed()) {
        <p class="card px-[18px] py-4 text-[13px] text-mute" role="status">
          {{ 'Metrics could not be read. They are tried again in 30 seconds.' | t }}
        </p>
      } @else if (metrics(); as m) {
        @if (!m.kept) {
          <p class="card px-[18px] py-4 text-[13px] text-mute" role="status">
            {{ 'This installation keeps no metrics: its control plane has no metrics store.' | t }}
          </p>
        } @else {
          <div class="grid gap-3.5 md:grid-cols-2">
            <sk-metric-chart
              label="CPU"
              unit="cores"
              [points]="first(m.cpu)"
              [max]="cores()"
              [caption]="coresCaption()"
              [from]="seconds(m.from)"
              [to]="seconds(m.to)"
              [step]="m.stepSeconds"
            />
            <sk-metric-chart
              label="Memory"
              unit="bytes"
              [points]="first(m.memory)"
              [max]="latest(m.memoryTotal)"
              [caption]="total(m.memoryTotal)"
              [from]="seconds(m.from)"
              [to]="seconds(m.to)"
              [step]="m.stepSeconds"
            />
            <sk-metric-chart
              label="Disk"
              unit="bytes"
              [points]="first(m.disk)"
              [max]="latest(m.diskTotal)"
              [caption]="total(m.diskTotal)"
              [from]="seconds(m.from)"
              [to]="seconds(m.to)"
              [step]="m.stepSeconds"
            />
            <sk-metric-chart
              label="Network in · out dashed"
              unit="bytesPerSecond"
              [points]="first(m.received)"
              [secondary]="first(m.sent)"
              [caption]="sent(m.sent)"
              [from]="seconds(m.from)"
              [to]="seconds(m.to)"
              [step]="m.stepSeconds"
            />
          </div>
        }
      } @else if (current()) {
        <p class="text-[12.5px] text-mute" role="status">{{ 'Loading…' | t }}</p>
      }
    </section>
  `,
})
export class NodeMetricsPanel {
  readonly organizationId = input.required<string>();
  readonly nodes = input.required<readonly FleetNode[]>();

  private readonly api = inject(FleetApi);
  protected readonly i18n = inject(I18n);
  protected readonly ranges: readonly MetricsRange[] = ['1h', '24h', '7d'];
  protected readonly range = signal<MetricsRange>('1h');
  private readonly picked = signal<string | null>(null);
  /** The server picked, or the first one while none is (or it was removed). */
  protected readonly current = computed(() => {
    const nodes = this.nodes();
    return nodes.find((node) => node.id === this.picked()) ?? nodes.at(0) ?? null;
  });
  protected readonly metrics = signal<NodeMetrics | null>(null);
  protected readonly failed = signal(false);
  /** Cores the server reported when it enrolled, as the top of the CPU scale. */
  protected readonly cores = computed(() => {
    const facts = this.current()?.facts;
    const count = facts?.['cpu_count'];
    return typeof count === 'number' && count > 0 ? count : null;
  });

  protected readonly coresCaption = computed(() => {
    const cores = this.cores();
    return cores === null ? '' : this.i18n.t('of {total}', { total: `${String(cores)} CPU` });
  });

  constructor() {
    effect((onCleanup) => {
      const organizationId = this.organizationId();
      const nodeId = this.current()?.id;
      const range = this.range();
      this.metrics.set(null);
      this.failed.set(false);
      if (!nodeId) return;
      let stale = false;
      // Only the latest request may answer: a slow older one never replaces a newer answer.
      let latest = 0;
      const load = async () => {
        const request = ++latest;
        try {
          const answer = await this.api.nodeMetrics(organizationId, nodeId, range);
          if (stale || request !== latest) return;
          this.metrics.set(answer);
          this.failed.set(false);
        } catch {
          if (!stale && request === latest) this.failed.set(true);
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
  }

  protected pick(nodeId: string): void {
    this.picked.set(nodeId);
  }

  protected first(
    series: readonly { readonly points: readonly MetricPoint[] }[],
  ): readonly MetricPoint[] {
    return series[0]?.points ?? [];
  }

  protected latest(series: readonly { readonly points: readonly MetricPoint[] }[]): number | null {
    return this.first(series).at(-1)?.v ?? null;
  }

  private format(value: number, unit: 'bytes' | 'bytesPerSecond'): string {
    return formatMetric(value, unit, (n, digits) => this.i18n.number(n, digits));
  }

  protected total(series: readonly { readonly points: readonly MetricPoint[] }[]): string {
    const value = this.latest(series);
    return value === null ? '' : this.i18n.t('of {total}', { total: this.format(value, 'bytes') });
  }

  protected sent(series: readonly { readonly points: readonly MetricPoint[] }[]): string {
    const value = this.latest(series);
    return value === null
      ? ''
      : this.i18n.t('out {rate}', { rate: this.format(value, 'bytesPerSecond') });
  }

  protected seconds(iso: string): number {
    return Date.parse(iso) / 1000;
  }
}
