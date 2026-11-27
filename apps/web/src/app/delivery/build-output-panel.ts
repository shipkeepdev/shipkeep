import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  type ElementRef,
  inject,
  Injector,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { Icon } from '../shell/icon';
import { T } from '../ui/i18n';

import { type BuildLine, DeliveryApi, type EnvironmentRef } from './delivery-api';
import { buildLineKey, clock, mergeBuildLines, overlapFrom, readForward } from './logs-view';

/** How often the page reads newer lines while the deployment runs. */
const LIVE_MS = 3000;
/** Lines one request asks for: the most the API answers. */
const LIMIT = 500;
/** Pages the first read goes through: a whole build, as the agent holds at most 8192 lines. */
const FIRST_ROUNDS = 17;
/** Once the deployment has finished, how many more reads catch the lines still on their way. */
const SETTLE_READS = 2;
/** How close to the bottom the view counts as following the build. */
const FOLLOW_PX = 24;

/**
 * One deployment's build output (ADR 0032), oldest first as the builder wrote it, read again while
 * the deployment runs. Secret values arrive already redacted.
 */
@Component({
  selector: 'sk-build-output',
  imports: [Icon, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-2.5' },
  template: `
    <div class="flex items-baseline justify-between gap-3">
      <h2 id="build-output-title" class="text-[14px] font-medium">{{ 'Build output' | t }}</h2>
      <span class="text-[12px] text-dim">{{ 'Rootless BuildKit' | t }}</span>
    </div>
    @if (failed()) {
      <div class="alert flex flex-wrap items-center justify-between gap-3" role="alert">
        <span>{{ 'The build output could not be loaded.' | t }}</span>
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
      <div
        #output
        class="max-h-[420px] overflow-auto rounded-[14px] border border-line bg-black px-4 py-3.5 font-mono text-[12px] leading-[1.8]"
        role="log"
        aria-live="off"
        aria-labelledby="build-output-title"
        tabindex="0"
      >
        @for (l of lines(); track key(l)) {
          <div class="whitespace-pre-wrap wrap-anywhere text-[#C8C8CF]">
            <time class="text-dim3" [attr.datetime]="l.time">{{ clock(l.time) }} </time>{{ l.line }}
            @if (l.truncated) {
              <span class="text-dim"> …</span>
            }
          </div>
        } @empty {
          <div class="text-dim" [attr.role]="loading() ? 'status' : null">
            {{ empty() | t }}
          </div>
        }
        @if (running() && lines().length) {
          <div class="text-blue">{{ 'now' | t }} · {{ 'reading the build output…' | t }}</div>
        }
      </div>
      @if (full()) {
        <div class="note note-warn">
          <sk-icon name="alert-triangle" class="text-amber" />
          <span>{{ 'Only the last 8192 lines of the build are shown.' | t }}</span>
        </div>
      }
    }
  `,
})
export class BuildOutputPanel {
  private readonly api = inject(DeliveryApi);
  private readonly injector = inject(Injector);
  readonly environment = input.required<EnvironmentRef>();
  readonly applicationId = input.required<string>();
  readonly deploymentId = input.required<string>();
  /** True while the deployment runs: the page reads newer lines only then, and a little after. */
  readonly running = input(false);
  protected readonly lines = signal<BuildLine[]>([]);
  protected readonly kept = signal<boolean | null>(null);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly full = signal(false);
  protected readonly clock = clock;
  protected readonly key = buildLineKey;
  private readonly output = viewChild<ElementRef<HTMLElement>>('output');
  /** The deployment the lines shown belong to; another one, or the page's end, drops a late read. */
  private generation = 0;
  /** The read under way, if any: the next tick waits for it instead of reading the same lines. */
  private reading: symbol | undefined;
  /** Where a read that stopped on a full page goes on; otherwise a little before the last line. */
  private resume: string | undefined;
  /** Reads left once the deployment has finished; none for one that had finished already. */
  private settling = 0;

  constructor() {
    effect(() => {
      this.environment();
      this.applicationId();
      this.deploymentId();
      untracked(() => {
        this.generation++;
        this.lines.set([]);
        this.kept.set(null);
        this.full.set(false);
        this.resume = undefined;
        this.settling = 0;
        void this.load();
      });
    });
    effect((onCleanup) => {
      const running = this.running();
      if (running) this.settling = SETTLE_READS;
      if (!running && this.settling === 0) return;
      const timer = setInterval(() => {
        // Once the deployment has finished, a few more reads catch the lines still on their way.
        if (!running) {
          if (this.settling === 0) {
            clearInterval(timer);
            return;
          }
          this.settling--;
        }
        void this.load();
      }, LIVE_MS);
      onCleanup(() => {
        clearInterval(timer);
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.generation++;
    });
  }

  protected empty(): string {
    if (this.loading()) return 'Loading…';
    return this.running() ? 'The build has written nothing yet.' : 'No build output was kept.';
  }

  protected reload(): void {
    void this.load();
  }

  /**
   * Reads the lines after the last one shown, page after page while pages come back full, from a
   * little before it: lines of one build may reach the store in batches written side by side.
   */
  private async load(): Promise<void> {
    // A tick waits for the read under way; an installation that keeps no logs is not asked again.
    if (this.reading !== undefined || this.kept() === false) return;
    const generation = this.generation;
    const environment = this.environment();
    const applicationId = this.applicationId();
    const deploymentId = this.deploymentId();
    const last = this.lines().at(-1)?.time;
    const from = this.resume ?? (last ? overlapFrom(last) : undefined);
    const read = Symbol('read');
    this.reading = read;
    try {
      let kept = true;
      const page = async (at: string | undefined) => {
        const answer = await this.api.buildOutput(environment, applicationId, deploymentId, {
          ...(at ? { from: at } : {}),
          limit: LIMIT,
        });
        kept = answer.kept;
        return answer.lines;
      };
      let found: { lines: BuildLine[]; resume?: string | undefined };
      if (from) {
        found = await readForward(page, from, LIMIT);
      } else {
        // The first page starts with the deployment; the next ones from its last line.
        const first = await page(undefined);
        const next = first.at(-1);
        found =
          first.length < LIMIT || !next
            ? { lines: [...first] }
            : await readForward(page, next.time, LIMIT, FIRST_ROUNDS - 1).then((rest) => ({
                lines: [...first, ...rest.lines],
                resume: rest.resume,
              }));
      }
      if (generation !== this.generation) return;
      const box = this.output()?.nativeElement;
      const following = !box || box.scrollHeight - box.scrollTop - box.clientHeight < FOLLOW_PX;
      const merged = mergeBuildLines(this.lines(), found.lines);
      if (merged.dropped) this.full.set(true);
      this.kept.set(kept);
      this.lines.set(merged.lines);
      this.resume = found.resume;
      this.failed.set(false);
      // A reader at the bottom follows the build; one who scrolled up stays where they are.
      if (following && found.lines.length)
        afterNextRender(
          () => {
            const element = this.output()?.nativeElement;
            if (element) element.scrollTop = element.scrollHeight;
          },
          { injector: this.injector },
        );
    } catch {
      if (generation === this.generation) this.failed.set(true);
    } finally {
      if (this.reading === read) this.reading = undefined;
      if (generation === this.generation) this.loading.set(false);
    }
  }
}
