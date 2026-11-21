import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';

import { linePath, type MetricPoint, sumSeries } from '../delivery/metric-chart';
import { ShellContext } from '../shell/shell-context';
import { I18n, T } from '../ui/i18n';
import {
  type OrganizationMetrics,
  type OrganizationMetricsRange,
  WorkspaceApi,
} from '../workspace/workspace-api';
import { RED } from './format';

/** One step of the chart: requests and 5xx answers per second, at unix seconds t. */
export interface RequestStep {
  readonly t: number;
  readonly requests: number;
  readonly errors: number;
}

/** Requests of every status class and 5xx answers, step by step, in time order. */
export function requestSteps(metrics: OrganizationMetrics): RequestStep[] {
  const errors = new Map<number, number>(
    (metrics.requests.find((series) => series.labels['status'] === '5xx')?.points ?? []).map(
      (point): [number, number] => [point.t, point.v],
    ),
  );
  return sumSeries(metrics.requests).map((point) => ({
    t: point.t,
    requests: point.v,
    errors: errors.get(point.t) ?? 0,
  }));
}

/** Whether an answer carries the series and period the chart reads. */
function readable(answer: unknown): answer is OrganizationMetrics {
  if (typeof answer !== 'object' || answer === null) return false;
  const fields = answer as Record<string, unknown>;
  return (
    Array.isArray(fields['requests']) &&
    Array.isArray(fields['duration']) &&
    typeof fields['stepSeconds'] === 'number' &&
    typeof fields['from'] === 'string' &&
    typeof fields['to'] === 'string'
  );
}

/** Requests over the period: each step's rate times its length. */
export function totalRequests(steps: readonly RequestStep[], step: number): number {
  return steps.reduce((sum, point) => sum + point.requests * step, 0);
}

/** Mean response time over the period, each step weighted by its requests; null without any. */
export function meanSeconds(
  steps: readonly RequestStep[],
  duration: readonly MetricPoint[],
): number | null {
  const requests = new Map(steps.map((point) => [point.t, point.requests]));
  let weighted = 0;
  let count = 0;
  for (const point of duration) {
    const weight = requests.get(point.t) ?? 0;
    weighted += point.v * weight;
    count += weight;
  }
  return count > 0 ? weighted / count : null;
}

/** A round top for a scale: 1, 2 or 5 times a power of ten, at least the largest value. */
export function roundTop(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 5, 10].find((factor) => factor * power >= value) ?? 10) * power;
}

/**
 * The area under a series in a 100 × 100 box, one closed shape per run of points: a gap of more
 * than two steps leaves the time without samples empty, as linePath does.
 */
export function areaPath(
  points: readonly MetricPoint[],
  from: number,
  to: number,
  top: number,
  step: number,
): string {
  const span = to > from ? to - from : 1;
  const x = (t: number) => (((t - from) / span) * 100).toFixed(2);
  const y = (v: number) => (100 - (Math.min(v, top) / top) * 100).toFixed(2);
  const runs: MetricPoint[][] = [];
  for (const point of points) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    if (run && last && point.t - last.t <= 2 * step) run.push(point);
    else runs.push([point]);
  }
  return runs
    .map((run) => {
      const first = run.at(0);
      const last = run.at(-1);
      if (!first || !last) return '';
      const line = run.map((point) => `L${x(point.t)} ${y(point.v)}`).join(' ');
      return `M${x(first.t)} 100 ${line} L${x(last.t)} 100 Z`;
    })
    .join(' ');
}

/**
 * Requests served by the organization's applications (ADR 0024), over the environments this
 * account reads: total and mean response time over the period, requests per minute with 5xx in
 * red, and the values of the step under the pointer.
 */
@Component({
  selector: 'sk-requests-chart',
  imports: [T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card min-w-0 flex-[2_1_560px] px-5 pt-5 pb-3.5' },
  template: `
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div class="text-[13px] text-mute">{{ 'Requests served · all apps' | t }}</div>
        <div class="mt-1.5 flex items-baseline gap-2">
          <span class="text-[30px] font-medium tracking-[-0.02em]">{{ total() }}</span>
          @if (mean(); as m) {
            <span class="text-[12.5px] text-mute2">{{ 'mean {value}' | t: { value: m } }}</span>
          }
        </div>
      </div>
      <div class="seg" role="group" [attr.aria-label]="'Period' | t">
        @for (p of periods; track p.value) {
          <button
            type="button"
            class="font-mono"
            [attr.aria-pressed]="range() === p.value"
            (click)="range.set(p.value); hover.set(null)"
          >
            {{ p.label | t }}
          </button>
        }
      </div>
    </div>
    <div class="mt-3.5 grid h-[230px] grid-cols-[34px_minmax(0,1fr)] gap-2">
      <div class="flex flex-col justify-between font-mono text-[10.5px] text-dim2">
        <span>{{ axis()[0] }}</span
        ><span>{{ axis()[1] }}</span
        ><span>0</span>
      </div>
      <div class="relative">
        <div class="absolute inset-0 flex flex-col justify-between">
          <div class="border-t border-dashed border-[#1d1d21]"></div>
          <div class="border-t border-dashed border-[#1d1d21]"></div>
          <div class="border-t border-line"></div>
        </div>
        @if (note(); as message) {
          <p
            class="absolute inset-0 grid place-items-center px-6 text-center text-[12.5px] text-mute"
            role="status"
          >
            {{ message | t }}
          </p>
        } @else {
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            class="absolute inset-0 size-full overflow-visible"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="sk-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#EDEDEF" stop-opacity="0.18" />
                <stop offset="1" stop-color="#EDEDEF" stop-opacity="0" />
              </linearGradient>
            </defs>
            <path [attr.d]="area()" fill="url(#sk-area)" />
            <path
              [attr.d]="line()"
              fill="none"
              stroke="#EDEDEF"
              stroke-width="1.5"
              vector-effect="non-scaling-stroke"
            />
            @if (errorLine()) {
              <path
                [attr.d]="errorLine()"
                fill="none"
                [attr.stroke]="red"
                stroke-width="1.2"
                vector-effect="non-scaling-stroke"
              />
            }
          </svg>
          @if (point(); as h) {
            <div
              class="pointer-events-none absolute inset-y-0 w-px bg-sep"
              [style.left]="h.left"
            ></div>
            <div
              class="pointer-events-none absolute -mt-[5.5px] -ml-[5.5px] size-[11px] rounded-full border-2 border-fg bg-black"
              [style.left]="h.left"
              [style.top]="h.top"
            ></div>
            <div
              class="pointer-events-none absolute top-1.5 flex flex-col gap-1 rounded-[9px] border border-ctl2 bg-sel px-[11px] py-2 whitespace-nowrap"
              [style.left]="h.left"
              [style.transform]="h.shift"
            >
              <span class="text-[11.5px] text-mute">{{ h.label }}</span>
              <span class="flex items-center gap-2 text-[12.5px]"
                ><span class="size-[7px] rounded-full bg-fg"></span>{{ 'Requests' | t }}
                <span class="ml-auto font-mono">{{ h.requests }}/min</span></span
              >
              <span class="flex items-center gap-2 text-[12.5px]"
                ><span class="size-[7px] rounded-full bg-red"></span>{{ '5xx errors' | t }}
                <span class="ml-auto font-mono">{{ h.errors }}</span></span
              >
            </div>
          }
          <div
            class="absolute inset-0 cursor-crosshair"
            (mousemove)="move($event)"
            (mouseleave)="hover.set(null)"
          ></div>
        }
      </div>
    </div>
    <div class="mt-2.5 ml-[42px] flex justify-between font-mono text-[10.5px] text-dim2">
      @for (x of labels(); track $index) {
        <span>{{ x }}</span>
      }
    </div>
  `,
})
export class RequestsChart {
  private readonly api = inject(WorkspaceApi);
  private readonly shell = inject(ShellContext);
  private readonly i18n = inject(I18n);
  protected readonly red = RED;
  protected readonly periods: readonly { value: OrganizationMetricsRange; label: string }[] = [
    { value: '24h', label: '24 h' },
    { value: '7d', label: '7 d' },
    { value: '30d', label: '30 d' },
  ];
  protected readonly range = signal<OrganizationMetricsRange>('24h');
  protected readonly hover = signal<number | null>(null);
  protected readonly metrics = signal<OrganizationMetrics | null>(null);
  protected readonly failed = signal(false);
  /** The organization and period the metrics shown belong to. */
  private shown: string | null = null;

  private readonly steps = computed(() => {
    const metrics = this.metrics();
    return metrics ? requestSteps(metrics) : [];
  });
  private readonly window = computed(() => {
    const metrics = this.metrics();
    if (!metrics) return null;
    return {
      from: Date.parse(metrics.from) / 1000,
      to: Date.parse(metrics.to) / 1000,
      step: metrics.stepSeconds,
    };
  });
  /** Top of the scale, in requests per minute. */
  private readonly top = computed(() =>
    roundTop(Math.max(0, ...this.steps().map((point) => point.requests * 60))),
  );

  protected readonly note = computed(() => {
    if (this.failed()) return 'Metrics could not be read. They are tried again in 30 seconds.';
    const metrics = this.metrics();
    if (!metrics) return 'Loading…';
    if (!metrics.kept)
      return 'This installation keeps no metrics: its control plane has no metrics store.';
    if (this.steps().length === 0) return 'No requests measured in this period yet.';
    return null;
  });

  private perMinute(pick: (point: RequestStep) => number): MetricPoint[] {
    return this.steps().map((point) => ({ t: point.t, v: pick(point) * 60 }));
  }
  protected readonly line = computed(() => {
    const w = this.window();
    return w
      ? linePath(
          this.perMinute((p) => p.requests),
          w.from,
          w.to,
          this.top(),
          w.step,
        )
      : '';
  });
  protected readonly area = computed(() => {
    const w = this.window();
    return w
      ? areaPath(
          this.perMinute((p) => p.requests),
          w.from,
          w.to,
          this.top(),
          w.step,
        )
      : '';
  });
  protected readonly errorLine = computed(() => {
    const w = this.window();
    if (!w || !this.steps().some((point) => point.errors > 0)) return '';
    return linePath(
      this.perMinute((p) => p.errors),
      w.from,
      w.to,
      this.top(),
      w.step,
    );
  });

  protected readonly total = computed(() => {
    const w = this.window();
    if (!w || this.note()) return '—';
    return this.compact(totalRequests(this.steps(), w.step));
  });
  protected readonly mean = computed(() => {
    const metrics = this.metrics();
    if (!metrics || this.note()) return null;
    const seconds = meanSeconds(this.steps(), metrics.duration[0]?.points ?? []);
    if (seconds === null) return null;
    return seconds < 1
      ? `${this.i18n.number(seconds * 1000, seconds < 0.01 ? 1 : 0)} ms`
      : `${this.i18n.number(seconds, 2)} s`;
  });
  protected readonly axis = computed(() => {
    const top = this.top();
    return [this.compact(top), this.compact(top / 2)] as const;
  });

  private locale(): string {
    return this.i18n.language() === 'fr' ? 'fr-FR' : 'en-US';
  }
  private label(t: number): string {
    const date = new Date(t * 1000);
    switch (this.range()) {
      case '24h':
        return date.toLocaleTimeString(this.locale(), { hour: '2-digit', minute: '2-digit' });
      case '7d':
        return date.toLocaleDateString(this.locale(), { weekday: 'short' });
      case '30d':
        return date.toLocaleDateString(this.locale(), { day: 'numeric', month: 'short' });
    }
  }
  protected readonly labels = computed(() => {
    const w = this.window();
    if (!w) return [];
    return [0, 0.25, 0.5, 0.75, 1].map((f) => this.label(w.from + f * (w.to - w.from)));
  });

  /** The step under the pointer, or none: the chart shows no made-up value at rest. */
  protected readonly point = computed(() => {
    const w = this.window();
    const index = this.hover();
    const step = index === null ? undefined : this.steps()[index];
    if (!w || !step) return null;
    const left = ((step.t - w.from) / (w.to > w.from ? w.to - w.from : 1)) * 100;
    const perMinute = step.requests * 60;
    return {
      left: `${String(left)}%`,
      top: `${String(100 - (Math.min(perMinute, this.top()) / this.top()) * 100)}%`,
      shift: left > 66 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
      label:
        this.range() === '24h'
          ? this.label(step.t)
          : new Date(step.t * 1000).toLocaleString(this.locale(), {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            }),
      requests: this.i18n.number(perMinute, perMinute < 10 ? 1 : 0),
      errors: this.i18n.number(step.errors * w.step),
    };
  });

  constructor() {
    // Read again every 30 seconds, as the agents sample. Charts of another organization or period
    // are cleared at once; only the latest request may answer.
    effect((onCleanup) => {
      const organizationId = this.shell.organizationId();
      const range = this.range();
      if (!organizationId) return;
      const key = `${organizationId}/${range}`;
      if (key !== this.shown) {
        this.shown = key;
        this.metrics.set(null);
        this.failed.set(false);
      }
      let stale = false;
      let latest = 0;
      const load = async () => {
        const request = ++latest;
        try {
          const answer = await this.api.organizationMetrics(organizationId, range);
          if (stale || request !== latest) return;
          // An answer without its series is a failure, never a chart of nothing.
          if (!readable(answer)) throw new Error('unreadable metrics');
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

  /** 950, 1.2k, 34k, 1.2 M: totals and the scale, in the interface language. */
  private compact(value: number): string {
    if (value >= 1e6) return `${this.i18n.number(value / 1e6, value < 1e7 ? 1 : 0)} M`;
    if (value >= 1e3) return `${this.i18n.number(value / 1e3, value < 1e4 ? 1 : 0)}k`;
    return this.i18n.number(value, value > 0 && value < 10 ? 1 : 0);
  }

  protected move(event: MouseEvent): void {
    const w = this.window();
    const steps = this.steps();
    if (!w || steps.length === 0) return;
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const t = w.from + ((event.clientX - box.left) / box.width) * (w.to - w.from);
    let nearest = 0;
    steps.forEach((point, index) => {
      const best = steps.at(nearest);
      if (best && Math.abs(point.t - t) < Math.abs(best.t - t)) nearest = index;
    });
    if (nearest !== this.hover()) this.hover.set(nearest);
  }
}
