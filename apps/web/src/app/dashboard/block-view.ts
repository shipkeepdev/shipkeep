import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';

import { Icon } from '../shell/icon';
import { Brand } from '../ui/brand';
import { T } from '../ui/i18n';
import { Notice } from '../ui/notice';
import { type Block, type Cell, type CellInput, type CodeLine, type Row } from './screen-model';
import { viewCommands } from './views';

const cell = (input: CellInput): Cell => (typeof input === 'string' ? { t: input } : input);
const row = (input: Row | readonly CellInput[]): Row =>
  Array.isArray(input) ? { cells: input as readonly CellInput[] } : (input as Row);
const line = (input: string | CodeLine): CodeLine =>
  typeof input === 'string' ? { t: input } : input;

/** One block of a dashboard screen: stats, fields, a table, cards, code, steps, danger or a note. */
@Component({
  selector: 'sk-block',
  imports: [Icon, Brand, NgTemplateOutlet, RouterLink, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-2.5' },
  template: `
    @let b = block();
    @if (b.title) {
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-[14px] font-medium">{{ b.title | t }}</span>
        <span class="text-[12px] text-dim">{{ b.aside | t }}</span>
      </div>
    }
    @switch (b.type) {
      @case ('stats') {
        <div class="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
          @for (k of b.items; track $index) {
            <div class="rounded-[14px] border border-line bg-black px-4 py-3.5">
              <div class="flex items-center gap-[7px] text-[12px] text-mute">
                <sk-icon [name]="k[0]" class="text-[14px]" />{{ k[1] | t }}
              </div>
              <div class="mt-2 text-[24px] tracking-[-0.02em]" [style.color]="k[4] || '#EDEDEF'">
                {{ k[2] | t }}
              </div>
              <div class="mt-0.5 text-[11.5px] text-dim">{{ k[3] | t }}</div>
            </div>
          }
        </div>
      }
      @case ('fields') {
        <div class="card px-5 py-1.5">
          @for (f of b.items; track $index) {
            <div class="field-row">
              <div>
                <div class="field-label">{{ f.l | t }}</div>
                @if (f.h) {
                  <div class="field-hint">{{ f.h | t }}</div>
                }
              </div>
              <div class="flex min-w-0 items-center gap-2">
                @if (f.toggle !== undefined) {
                  <button
                    type="button"
                    role="switch"
                    class="toggle"
                    [attr.aria-checked]="f.toggle"
                    [attr.aria-label]="f.l | t"
                    (click)="notice.notYet(f.l)"
                  ></button>
                  <span class="text-[12.5px] text-fg3">{{
                    f.v || (f.toggle ? 'Enabled' : 'Disabled') | t
                  }}</span>
                } @else {
                  <div class="field-box" [class.font-mono]="f.mono !== false">
                    <span class="min-w-0 flex-1 truncate">{{ f.v | t }}</span>
                    @if (f.tag) {
                      <span class="font-sans text-[10.5px] whitespace-nowrap text-mute">{{
                        f.tag | t
                      }}</span>
                    }
                  </div>
                }
              </div>
            </div>
          }
        </div>
      }
      @case ('table') {
        <div class="card overflow-x-auto">
          <div class="min-w-[560px]">
            <div class="grid-table th px-[18px] py-[11px]" [style.grid-template-columns]="b.cols">
              @for (h of b.heads; track $index) {
                <span>{{ h | t }}</span>
              }
            </div>
            @for (r of rows(); track $index) {
              @let target = commands(r.go);
              @if (target) {
                <a
                  [routerLink]="target"
                  class="grid-table border-t border-line2 px-[18px] py-3 text-[12.5px] hover:bg-[#0a0a0b]"
                  [style.grid-template-columns]="b.cols"
                >
                  <ng-container *ngTemplateOutlet="cells; context: { $implicit: r.cells }" />
                </a>
              } @else {
                <div
                  class="grid-table border-t border-line2 px-[18px] py-3 text-[12.5px]"
                  [style.grid-template-columns]="b.cols"
                >
                  <ng-container *ngTemplateOutlet="cells; context: { $implicit: r.cells }" />
                </div>
              }
            }
            @if (b.add) {
              <div class="border-t border-line2 px-[18px] py-3">
                <button type="button" class="btn btn-sm" (click)="notice.notYet(b.add)">
                  <sk-icon name="plus" />{{ b.add | t }}
                </button>
              </div>
            }
          </div>
        </div>
      }
      @case ('cards') {
        <div class="grid gap-3" [style.grid-template-columns]="cardColumns()">
          @for (r of b.items; track $index) {
            @let target = commands(r.go);
            <a
              [routerLink]="target"
              [attr.tabindex]="target ? null : -1"
              class="flex flex-col gap-3 rounded-2xl border bg-black p-4 transition-[border-color] duration-200 hover:border-[#3A3A40]"
              [class.cursor-pointer]="target"
              [class.cursor-default]="!target"
              [style.border-color]="r.hl ? 'rgba(255,92,92,0.35)' : null"
              [class.border-line]="!r.hl"
            >
              <div class="flex items-center gap-3">
                <span
                  class="grid size-[38px] shrink-0 place-items-center rounded-[10px] border border-line"
                >
                  @if (r.logo) {
                    <sk-brand [name]="r.logo" class="size-5 text-fg2" />
                  } @else if (r.icon) {
                    <sk-icon [name]="r.icon" class="text-[19px] text-fg2" />
                  }
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-[7px] text-[13.5px] font-medium">
                    {{ r.name | t }}
                    @if (r.badge) {
                      <span
                        class="flex items-center gap-[5px] rounded-full border border-ctl px-2 py-px text-[10.5px] font-normal whitespace-nowrap"
                        [style.color]="r.bc || '#A6A6AE'"
                        ><span
                          class="size-[5px] rounded-full"
                          [style.background]="r.bc || '#A6A6AE'"
                        ></span
                        >{{ r.badge | t }}</span
                      >
                    }
                  </div>
                  <div class="mt-0.5 text-[11.5px] text-dim">{{ r.sub | t }}</div>
                </div>
              </div>
              @if (r.desc) {
                <div class="flex-1 text-[12.5px] leading-normal text-fg3">{{ r.desc | t }}</div>
              }
              @if (r.meta) {
                <div
                  class="flex flex-wrap gap-3.5 border-t border-line2 pt-3 text-[11.5px] text-mute"
                >
                  @for (m of r.meta; track $index) {
                    <span class="flex items-center gap-[5px]"
                      ><sk-icon [name]="m[0]" class="text-[13px]" />{{ m[1] | t }}</span
                    >
                  }
                </div>
              }
              @if (r.cta) {
                <div class="flex justify-end border-t border-line2 pt-3">
                  <button
                    type="button"
                    class="btn btn-sm btn-primary"
                    (click)="$event.preventDefault(); notice.notYet(r.name)"
                  >
                    {{ r.cta | t }}
                  </button>
                </div>
              }
            </a>
          }
        </div>
      }
      @case ('code') {
        <div
          class="overflow-auto rounded-[14px] border border-line bg-black px-4 py-3.5 font-mono text-[12px] leading-[1.8]"
          [style.max-height]="b.mh || null"
        >
          @for (l of lines(); track $index) {
            <div class="whitespace-pre" [style.color]="l.c || '#C8C8CF'">
              <span class="text-dim3">{{ l.p }}</span
              >{{ l.t | t }}
            </div>
          }
        </div>
      }
      @case ('steps') {
        <div class="flex flex-col gap-2.5">
          @for (s of b.items; track $index) {
            @let done = s.state === 'done';
            @let active = s.state === 'active';
            <div
              class="flex items-center gap-4 rounded-2xl border bg-black px-[18px] py-4 max-sm:flex-wrap"
              [style.border-color]="active ? 'rgba(255,92,92,0.4)' : '#1C1C1E'"
            >
              <span
                class="grid size-[30px] shrink-0 place-items-center rounded-full border"
                [style.border-color]="done ? '#F2F2F3' : active ? '#EDEDEF' : '#262628'"
                [style.background]="done ? '#F2F2F3' : '#000'"
                ><sk-icon
                  [name]="done ? 'check' : s.icon"
                  class="text-[15px]"
                  [style.color]="done ? '#000' : active ? '#EDEDEF' : '#6B6B74'"
              /></span>
              <div class="min-w-0 flex-1">
                <div class="text-[14px]" [style.color]="done ? '#8B8B93' : '#EDEDEF'">
                  {{ s.t | t }}
                </div>
                <div class="mt-[3px] text-[12.5px] text-mute2">{{ s.d | t }}</div>
              </div>
              @if (s.cta) {
                @let target = commands(s.go);
                <a
                  [routerLink]="target"
                  class="btn btn-sm font-medium"
                  [class.btn-primary]="active"
                  >{{ s.cta | t }}</a
                >
              }
            </div>
          }
        </div>
      }
      @case ('danger') {
        <div class="overflow-hidden rounded-2xl border border-[rgb(255_92_92/35%)] bg-black">
          @for (d of b.items; track $index) {
            <div
              class="flex items-center justify-between gap-4 px-5 py-4 max-sm:flex-wrap"
              [class.border-t]="$index"
              [class.border-line2]="$index"
            >
              <div>
                <div class="text-[13.5px]">{{ d[0] | t }}</div>
                <div class="mt-[3px] text-[12px] text-mute2">{{ d[1] | t }}</div>
              </div>
              <button type="button" class="btn btn-danger" (click)="notice.notYet(d[0])">
                {{ d[2] | t }}
              </button>
            </div>
          }
        </div>
      }
      @case ('note') {
        <div
          class="note"
          [class.note-warn]="b.tone === 'warn'"
          [class.note-ours]="b.tone === 'ours'"
        >
          <sk-icon
            [name]="
              b.tone === 'warn'
                ? 'alert-triangle'
                : b.tone === 'ours'
                  ? 'shield-lock'
                  : 'info-circle'
            "
            [style.color]="
              b.tone === 'warn' ? 'oklch(0.80 0.12 80)' : b.tone === 'ours' ? '#FF8A8A' : '#8B8B93'
            "
          />
          <span>{{ b.text | t }}</span>
        </div>
      }
    }
    <ng-template #cells let-list>
      @for (c of list; track $index) {
        @let x = asCell(c);
        <span
          class="flex min-w-0 items-center gap-[7px] truncate"
          [class.font-mono]="x.mono"
          [style.color]="x.fg || (x.dim ? '#6B6B74' : '#C8C8CF')"
        >
          @if (x.dot) {
            <span class="dot" [style.background]="x.dot"></span>
          }
          @if (x.logo) {
            <sk-brand [name]="x.logo" class="size-[15px] text-fg3" />
          }
          @if (x.icon) {
            <sk-icon [name]="x.icon" class="text-[15px] text-mute" />
          }
          <span class="truncate">{{ x.t | t }}</span>
        </span>
      }
    </ng-template>
  `,
})
export class BlockView {
  readonly block = input.required<Block>();
  readonly organizationId = input.required<string>();
  protected readonly notice = inject(Notice);
  protected readonly asCell = cell;
  protected readonly rows = computed(() => {
    const b = this.block();
    return b.type === 'table' ? b.rows.map(row) : [];
  });
  protected readonly lines = computed(() => {
    const b = this.block();
    return b.type === 'code' ? b.lines.map(line) : [];
  });
  protected readonly cardColumns = computed(() => {
    const b = this.block();
    return `repeat(auto-fill,minmax(min(100%,${b.type === 'cards' ? (b.min ?? '260px') : '260px'}),1fr))`;
  });

  protected commands(view: string | undefined): string[] | null {
    return viewCommands(this.organizationId(), view);
  }
}
