import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { I18n, T } from '../ui/i18n';
import { PreviewPill } from './screen-view';
import { RED } from './format';

type Period = 24 | 7 | 30;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Requests served by all applications. The control plane collects no traffic metrics yet, so the
 * chart draws the design's sample series and says so; the interaction is the real one.
 */
@Component({
  selector: 'sk-requests-chart',
  imports: [PreviewPill, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card min-w-0 flex-[2_1_560px] px-5 pt-5 pb-3.5' },
  template: `
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div class="flex flex-wrap items-center gap-2 text-[13px] text-mute">
          {{ 'Requests served · all apps' | t }}<sk-preview-pill />
        </div>
        <div class="mt-1.5 flex items-baseline gap-2">
          <span class="text-[30px] font-medium tracking-[-0.02em]">{{ total() }}</span>
          <span class="text-[12.5px] text-mute2">p95 {{ period() === 24 ? 412 : 398 }} ms</span>
        </div>
      </div>
      <div class="seg" role="group" [attr.aria-label]="'Period' | t">
        @for (p of periods; track p.value) {
          <button
            type="button"
            class="font-mono"
            [attr.aria-pressed]="period() === p.value"
            (click)="period.set(p.value); hover.set(null)"
          >
            {{ p.label | t }}
          </button>
        }
      </div>
    </div>
    <div class="mt-3.5 grid h-[230px] grid-cols-[34px_minmax(0,1fr)] gap-2">
      <div class="flex flex-col justify-between font-mono text-[10.5px] text-dim2">
        <span>{{ top() / 1000 }}k</span><span>{{ top() / 2000 }}k</span><span>0</span>
      </div>
      <div class="relative">
        <div class="absolute inset-0 flex flex-col justify-between">
          <div class="border-t border-dashed border-[#1d1d21]"></div>
          <div class="border-t border-dashed border-[#1d1d21]"></div>
          <div class="border-t border-line"></div>
        </div>
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
          <path [attr.d]="line() + ' L100 100 L0 100 Z'" fill="url(#sk-area)" />
          <path
            [attr.d]="line()"
            fill="none"
            stroke="#EDEDEF"
            stroke-width="1.5"
            vector-effect="non-scaling-stroke"
          />
          <path
            [attr.d]="errors()"
            fill="none"
            [attr.stroke]="red"
            stroke-width="1.2"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        @let h = point();
        <div class="pointer-events-none absolute inset-y-0 w-px bg-sep" [style.left]="h.left"></div>
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
        <div
          class="absolute inset-0 cursor-crosshair"
          (mousemove)="move($event)"
          (mouseleave)="hover.set(null)"
        ></div>
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
  private readonly i18n = inject(I18n);
  protected readonly red = RED;
  protected readonly periods: readonly { value: Period; label: string }[] = [
    { value: 24, label: '24 h' },
    { value: 7, label: '7 d' },
    { value: 30, label: '30 d' },
  ];
  protected readonly period = signal<Period>(24);
  protected readonly hover = signal<number | null>(null);
  private readonly series = computed(() => {
    const n = this.period();
    const requests: number[] = [];
    const errors: number[] = [];
    for (let i = 0; i < n; i++) {
      requests.push(
        Math.round(
          1800 +
            1400 * Math.sin((i / n) * Math.PI * (n === 24 ? 1 : n / 12) - 1.2) +
            500 * Math.sin(i * 1.3) +
            2200,
        ),
      );
      errors.push(Math.round(8 + (i % 9 === 4 ? 70 : 0) + 6 * Math.abs(Math.sin(i * 0.8))));
    }
    return { requests, errors };
  });
  protected readonly top = computed(
    () => Math.ceil(Math.max(...this.series().requests) / 1000) * 1000,
  );
  private y(value: number): number {
    return 100 - (value / this.top()) * 100;
  }
  private path(values: readonly number[], scale = 1): string {
    const n = values.length;
    return values
      .map(
        (v, i) =>
          `${i ? 'L' : 'M'}${((i / (n - 1)) * 100).toFixed(2)} ${this.y(v * scale).toFixed(2)}`,
      )
      .join(' ');
  }
  protected readonly line = computed(() => this.path(this.series().requests));
  protected readonly errors = computed(() => this.path(this.series().errors, 12));
  protected readonly total = computed(() => {
    const sum = this.series().requests.reduce((a, b) => a + b, 0);
    return `${this.i18n.number((sum * (this.period() === 24 ? 60 : 1440)) / 1e6, 1)} M`;
  });
  private label(i: number): string {
    const n = this.period();
    if (n === 24) return `${String(i).padStart(2, '0')}:00`;
    if (n === 7) return this.i18n.t(DAYS[i] ?? '');
    return this.i18n.t('Oct {day}', { day: i + 9 });
  }
  protected readonly labels = computed(() => {
    const n = this.period();
    return [0, 0.25, 0.5, 0.75, 1].map((f) => this.label(Math.round(f * (n - 1))));
  });
  protected readonly point = computed(() => {
    const n = this.period();
    const { requests, errors } = this.series();
    const i = this.hover() ?? Math.round((n - 1) * 0.68);
    const left = (i / (n - 1)) * 100;
    return {
      left: `${String(left)}%`,
      top: `${String(this.y(requests[i] ?? 0))}%`,
      shift: left > 66 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
      label: this.label(i),
      requests: this.i18n.number(requests[i] ?? 0),
      errors: String(errors[i] ?? 0),
    };
  });

  protected move(event: MouseEvent): void {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const n = this.period();
    const i = Math.max(
      0,
      Math.min(n - 1, Math.round(((event.clientX - box.left) / box.width) * (n - 1))),
    );
    if (i !== this.hover()) this.hover.set(i);
  }
}
