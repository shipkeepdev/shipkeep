import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { Icon } from '../shell/icon';
import { Brand } from '../ui/brand';
import { T } from '../ui/i18n';
import { Notice } from '../ui/notice';
import { BlockView } from './block-view';
import { type Screen, type Section } from './screen-model';
import { viewCommands } from './views';

/** Shown next to the title of a page whose content is the design's sample data. */
@Component({
  selector: 'sk-preview-pill',
  imports: [Icon, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'inline-flex items-center gap-1.5 rounded-full border border-[oklch(0.80_0.12_80/0.4)] px-2.5 py-[3px] text-[12px] text-amber',
    title: 'Sample data from the design: this screen is not connected to the control plane yet.',
  },
  template: `<sk-icon name="eye" class="text-[13px]" />{{ 'Preview · sample data' | t }}`,
})
export class PreviewPill {}

/**
 * A full dashboard screen from its description: header, then blocks, or sections chosen from a side
 * menu or tabs. The open section is in the URL (`?section=`), so a reload or a shared link keeps it.
 */
@Component({
  selector: 'sk-screen',
  imports: [BlockView, Brand, Icon, PreviewPill, RouterLink, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col gap-[18px]' },
  template: `
    @let s = screen();
    <div class="page-head">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-3">
          @if (s.logo) {
            <span class="grid size-[34px] place-items-center rounded-[9px] border border-line"
              ><sk-brand [name]="s.logo" class="size-[18px] text-fg2"
            /></span>
          }
          <h1 class="page-title">{{ s.title | t }}</h1>
          @for (p of s.pills ?? []; track $index) {
            <span class="pill" [style.color]="p[1] || '#A6A6AE'">
              @if (p[1]) {
                <span class="dot" [style.background]="p[1]"></span>
              }
              {{ p[0] | t }}
            </span>
          }
          @if (preview()) {
            <sk-preview-pill />
          }
        </div>
        @if (s.sub) {
          <div class="mt-1.5 max-w-[720px] text-[13px] text-pretty text-mute2">{{ s.sub | t }}</div>
        }
      </div>
      @if (s.actions?.length) {
        <div class="flex flex-wrap gap-2.5">
          @for (a of s.actions; track $index) {
            @let target = commands(a[3]);
            @if (target) {
              <a [routerLink]="target" class="btn" [class.btn-primary]="a[2]"
                ><sk-icon [name]="a[1]" />{{ a[0] | t }}</a
              >
            } @else {
              <button
                type="button"
                class="btn"
                [class.btn-primary]="a[2]"
                (click)="notice.notYet(a[0])"
              >
                <sk-icon [name]="a[1]" />{{ a[0] | t }}
              </button>
            }
          }
        </div>
      }
    </div>

    @if (useTabs()) {
      <nav class="tabbar" [attr.aria-label]="s.title | t">
        @for (x of sections(); track x.k) {
          <a
            [routerLink]="[]"
            [queryParams]="{ section: x.k }"
            [attr.aria-current]="x === current() ? 'page' : null"
            ><sk-icon [name]="x.icon ?? 'point'" />{{ x.label | t }}</a
          >
        }
      </nav>
    }

    <div
      class="grid items-start gap-7"
      [class]="useSide() ? 'md:grid-cols-[210px_minmax(0,1fr)]' : ''"
    >
      @if (useSide()) {
        <nav
          class="flex flex-col gap-0.5 max-md:flex-row max-md:overflow-x-auto md:sticky md:top-3"
          [attr.aria-label]="s.title | t"
        >
          @for (x of sections(); track x.k) {
            <div class="flex shrink-0 flex-col">
              @if (x.head) {
                <div class="sidenav-head max-md:hidden">{{ x.head | t }}</div>
              }
              <a
                class="sidenav-item max-md:whitespace-nowrap"
                [class.danger]="x.k === 'danger'"
                [routerLink]="[]"
                [queryParams]="{ section: x.k }"
                [attr.aria-current]="x === current() ? 'page' : null"
              >
                <sk-icon [name]="x.icon ?? 'point'" />
                <span class="flex-1">{{ x.label | t }}</span>
                @if (x.ours) {
                  <span class="size-[5px] rounded-full bg-coral" title="Shipkeep"></span>
                }
              </a>
            </div>
          }
        </nav>
      }
      <div class="flex min-w-0 flex-col gap-4">
        @if (useSide()) {
          @let c = current();
          <div>
            <div class="flex items-center gap-2.5">
              <span class="sec-title">{{ c.title || c.label | t }}</span>
              @if (c.ours) {
                <span class="tag-ours">Shipkeep</span>
              }
            </div>
            @if (c.desc) {
              <div class="sec-desc">{{ c.desc | t }}</div>
            }
          </div>
        }
        @for (b of current().blocks; track $index) {
          <sk-block [block]="b" [organizationId]="organizationId()" />
        }
      </div>
    </div>
  `,
})
export class ScreenView {
  readonly screen = input.required<Screen>();
  readonly organizationId = input.required<string>();
  readonly preview = input(false);
  protected readonly notice = inject(Notice);
  private readonly section = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((params) => params.get('section'))),
  );
  protected readonly sections = computed<readonly Section[]>(() => {
    const s = this.screen();
    return s.sections ?? [{ k: 'main', label: s.title, blocks: s.blocks ?? [] }];
  });
  protected readonly current = computed(() => {
    const all = this.sections();
    return all.find((x) => x.k === this.section()) ?? all[0];
  });
  protected readonly useTabs = computed(
    () => this.screen().layout === 'tabs' && this.sections().length > 1,
  );
  protected readonly useSide = computed(
    () => this.screen().layout !== 'tabs' && this.sections().length > 1,
  );

  protected commands(view: string | undefined): string[] | null {
    return viewCommands(this.organizationId(), view);
  }
}
