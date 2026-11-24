import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';

import { Icon } from '../shell/icon';
import { T } from '../ui/i18n';

import { DeliveryApi, type EnvironmentRef, type LogLine } from './delivery-api';
import { clock, lineKey, mergeLines } from './logs-view';

type Filter = 'all' | 'stdout' | 'stderr';

/** How often the live view asks for newer lines. */
const LIVE_MS = 3000;

/**
 * An application's logs (ADR 0029): its replicas' output, newest first, with a search and a live
 * view that asks for newer lines while the tab is shown. Secret values arrive already redacted.
 */
@Component({
  selector: 'sk-application-logs',
  imports: [Icon, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-3' },
  template: `
    @if (failed()) {
      <div class="alert flex flex-wrap items-center justify-between gap-3" role="alert">
        <span>{{ 'The logs could not be loaded.' | t }}</span>
        <button class="btn btn-sm" type="button" (click)="reload()">{{ 'Retry' | t }}</button>
      </div>
    }
    @if (kept() === false) {
      <p class="note">
        <sk-icon name="info-circle" class="text-mute" />{{
          'This installation keeps no logs: its control plane has no log store.' | t
        }}
      </p>
    } @else {
      <div class="card overflow-hidden">
        <div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          @for (f of filters; track f.k) {
            <button
              type="button"
              class="rounded-lg border px-2.5 py-[5px] text-[12px]"
              [class.border-fg]="filter() === f.k"
              [class.text-fg]="filter() === f.k"
              [class.border-line]="filter() !== f.k"
              [class.text-mute]="filter() !== f.k"
              [attr.aria-pressed]="filter() === f.k"
              (click)="choose(f.k)"
            >
              {{ f.label | t }}
            </button>
          }
          <form
            class="min-w-[160px] flex-1"
            role="search"
            (submit)="$event.preventDefault(); search()"
          >
            <input
              #query
              type="search"
              class="w-full rounded-lg border border-line bg-transparent px-2.5 py-[5px] font-mono text-[12px] text-fg"
              maxlength="256"
              [attr.aria-label]="'Search the logs' | t"
              [placeholder]="'Search the logs' | t"
              (input)="text.set(query.value)"
            />
          </form>
          <button
            type="button"
            class="flex items-center gap-1.5 text-[12px]"
            [class.text-mute]="!live()"
            [attr.aria-pressed]="live()"
            (click)="live.set(!live())"
          >
            <span class="dot" [class.bg-green]="live()" [class.bg-line]="!live()"></span
            >{{ (live() ? 'live' : 'paused') | t }}
          </button>
        </div>
        <div
          class="max-h-[440px] overflow-auto px-4 py-3 font-mono text-[12px] leading-[1.85]"
          role="log"
          aria-live="off"
          [attr.aria-label]="'Logs' | t"
        >
          @for (l of lines(); track key(l)) {
            <div
              class="grid grid-cols-[70px_34px_52px_minmax(0,1fr)] gap-x-2.5 max-sm:grid-cols-[auto_auto_minmax(0,1fr)] max-sm:pb-1.5"
            >
              <time class="text-dim3" [attr.datetime]="l.time">{{ clock(l.time) }}</time
              ><span class="text-dim">r{{ l.instance }}</span>
              <span
                [class.text-rose]="l.stream === 'stderr'"
                [class.text-mute]="l.stream === 'stdout'"
                >{{ l.stream }}</span
              >
              <span class="whitespace-pre-wrap break-all text-fg2 max-sm:col-span-full"
                >{{ l.line }}
                @if (l.truncated) {
                  <span class="text-dim"> …</span>
                }
              </span>
            </div>
          } @empty {
            <p class="text-[13px] text-mute2" [attr.role]="loading() ? 'status' : null">
              {{ (loading() ? 'Loading…' : 'No line in the last hour.') | t }}
            </p>
          }
        </div>
      </div>
    }
  `,
})
export class LogsPanel {
  private readonly api = inject(DeliveryApi);
  readonly environment = input.required<EnvironmentRef>();
  readonly applicationId = input.required<string>();
  /** True while the tab is shown: the live view asks only then. */
  readonly active = input(false);
  protected readonly filters: readonly { k: Filter; label: string }[] = [
    { k: 'all', label: 'All' },
    { k: 'stdout', label: 'stdout' },
    { k: 'stderr', label: 'stderr' },
  ];
  protected readonly filter = signal<Filter>('all');
  protected readonly text = signal('');
  protected readonly live = signal(true);
  protected readonly lines = signal<LogLine[]>([]);
  protected readonly kept = signal<boolean | null>(null);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly clock = clock;
  protected readonly key = lineKey;
  /** The search the lines shown answer; a newer one replaces them. */
  private generation = 0;

  constructor() {
    effect((onCleanup) => {
      const active = this.active();
      const live = this.live();
      this.environment();
      this.applicationId();
      if (!active) return;
      untracked(() => {
        void this.load(true);
      });
      if (!live) return;
      const timer = setInterval(() => {
        void this.load(false);
      }, LIVE_MS);
      onCleanup(() => {
        clearInterval(timer);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
    });
  }

  protected choose(filter: Filter): void {
    this.filter.set(filter);
    void this.load(true);
  }

  protected search(): void {
    void this.load(true);
  }

  protected reload(): void {
    void this.load(true);
  }

  /** Loads the newest lines; `fresh` starts again, otherwise it asks from the newest line on. */
  private async load(fresh: boolean): Promise<void> {
    const generation = fresh ? ++this.generation : this.generation;
    const newest = fresh ? undefined : this.lines().at(0)?.time;
    const stream = this.filter() === 'all' ? undefined : (this.filter() as 'stdout' | 'stderr');
    const text = this.text().trim();
    if (fresh) this.loading.set(true);
    try {
      const answer = await this.api.logs(this.environment(), this.applicationId(), {
        ...(text ? { text } : {}),
        ...(stream ? { stream } : {}),
        ...(newest ? { from: newest } : {}),
        limit: 200,
      });
      if (generation !== this.generation) return;
      this.kept.set(answer.kept);
      this.lines.set(mergeLines(fresh ? [] : this.lines(), answer.lines));
      this.failed.set(false);
    } catch {
      if (generation === this.generation) this.failed.set(true);
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
}
