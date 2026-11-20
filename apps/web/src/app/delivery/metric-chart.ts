import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { bytes, RED } from '../dashboard/format';
import { T } from '../ui/i18n';

/** A point of a series: unix seconds and a value. */
export interface MetricPoint {
  readonly t: number;
  readonly v: number;
}

export type MetricUnit = 'cores' | 'bytes' | 'perSecond' | 'seconds';

/** A value in its unit, as a chart's headline and axis show it. */
export function formatMetric(value: number, unit: MetricUnit): string {
  switch (unit) {
    case 'cores':
      return value < 0.1 ? `${String(Math.round(value * 1000))} m` : `${value.toFixed(2)} CPU`;
    case 'bytes':
      return bytes(value) ?? '0 MiB';
    case 'perSecond':
      return value < 10 ? `${value.toFixed(1)}/s` : `${String(Math.round(value))}/s`;
    case 'seconds':
      return value < 1 ? `${String(Math.round(value * 1000))} ms` : `${value.toFixed(2)} s`;
  }
}

/** Series of one query added point by point, such as requests of every status class. */
export function sumSeries(
  series: readonly { readonly points: readonly MetricPoint[] }[],
): MetricPoint[] {
  const byTime = new Map<number, number>();
  for (const item of series)
    for (const point of item.points) byTime.set(point.t, (byTime.get(point.t) ?? 0) + point.v);
  return [...byTime.entries()].sort(([a], [b]) => a - b).map(([t, v]) => ({ t, v }));
}

/** The top of a chart's scale: the largest value, or 1 for an empty or all-zero series. */
export function scaleTop(series: readonly (readonly MetricPoint[])[]): number {
  let top = 0;
  for (const points of series) for (const point of points) top = Math.max(top, point.v);
  return top > 0 ? top : 1;
}

/**
 * The SVG path of a series in a 100 × 100 box, time from `from` to `to` (unix seconds) left to
 * right, values from 0 to `top` bottom to top. A gap of more than two steps breaks the line, so a
 * time without samples is not drawn as a slope.
 */
export function linePath(
  points: readonly MetricPoint[],
  from: number,
  to: number,
  top: number,
  step: number,
): string {
  const span = to > from ? to - from : 1;
  let path = '';
  let previous: number | undefined;
  for (const point of points) {
    const x = ((point.t - from) / span) * 100;
    const y = 100 - (Math.min(point.v, top) / top) * 100;
    const move = previous === undefined || point.t - previous > 2 * step;
    path += `${move ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)} `;
    previous = point.t;
  }
  return path.trim();
}

/**
 * One chart of the metrics tab: a headline with the latest value, and the series over the period.
 * `errors`, when given, is drawn in red over the main series, on the same scale.
 */
@Component({
  selector: 'sk-metric-chart',
  imports: [T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card flex min-w-0 flex-col px-[18px] py-4' },
  template: `
    <div class="flex items-baseline justify-between gap-3">
      <span class="text-[13px] text-fg3">{{ label() | t }}</span>
      <span class="text-[20px] tracking-[-0.02em]">{{ latest() }}</span>
    </div>
    @if (empty()) {
      <p class="mt-3.5 grid h-[90px] place-items-center text-[12.5px] text-mute">
        {{ 'No data for this period yet.' | t }}
      </p>
    } @else {
      <div class="mt-3.5 grid h-[90px] grid-cols-[minmax(0,1fr)_auto] gap-2">
        <div class="relative">
          <div class="absolute inset-0 flex flex-col justify-between">
            <div class="border-t border-dashed border-[#1d1d21]"></div>
            <div class="border-t border-line"></div>
          </div>
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            class="absolute inset-0 size-full overflow-visible"
            role="img"
            [attr.aria-label]="(label() | t) + ': ' + latest()"
          >
            <path
              [attr.d]="main()"
              fill="none"
              stroke="#EDEDEF"
              stroke-width="1.5"
              vector-effect="non-scaling-stroke"
            />
            @if (errorPath()) {
              <path
                [attr.d]="errorPath()"
                fill="none"
                [attr.stroke]="red"
                stroke-width="1.2"
                vector-effect="non-scaling-stroke"
              />
            }
          </svg>
        </div>
        <span class="self-start font-mono text-[10.5px] text-dim2">{{ topLabel() }}</span>
      </div>
    }
  `,
})
export class MetricChart {
  readonly label = input.required<string>();
  readonly unit = input.required<MetricUnit>();
  readonly points = input.required<readonly MetricPoint[]>();
  readonly errors = input<readonly MetricPoint[]>([]);
  /** The period, unix seconds, and the step between two points. */
  readonly from = input.required<number>();
  readonly to = input.required<number>();
  readonly step = input.required<number>();

  protected readonly red = RED;
  protected readonly empty = computed(() => this.points().length === 0);
  private readonly top = computed(() => scaleTop([this.points(), this.errors()]));
  protected readonly main = computed(() =>
    linePath(this.points(), this.from(), this.to(), this.top(), this.step()),
  );
  protected readonly errorPath = computed(() =>
    this.errors().some((point) => point.v > 0)
      ? linePath(this.errors(), this.from(), this.to(), this.top(), this.step())
      : '',
  );
  protected readonly latest = computed(() => {
    const last = this.points().at(-1);
    return last ? formatMetric(last.v, this.unit()) : '—';
  });
  protected readonly topLabel = computed(() => formatMetric(this.top(), this.unit()));
}
