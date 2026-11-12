import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';

import { Icon } from '../shell/icon';
import { type IconName } from '../shell/icons';
import { I18n, T } from '../ui/i18n';

export interface PaletteEntry {
  readonly label: string;
  /** A name typed by a user: shown as is, never translated. */
  readonly raw?: boolean;
  readonly icon: IconName;
  readonly link: readonly string[];
}

/** ⌘K: jump to any page or project by typing part of its name. */
@Component({
  selector: 'sk-command-palette',
  imports: [Icon, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
      <button
        type="button"
        class="absolute inset-0 bg-black/70"
        tabindex="-1"
        [attr.aria-label]="'Close' | t"
        (click)="closed.emit()"
      ></button>
      <div
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="'Search' | t"
        class="relative w-full max-w-[560px] overflow-hidden rounded-2xl border border-ctl2 bg-black shadow-[0_24px_80px_rgb(0_0_0/70%)]"
      >
        <div class="flex items-center gap-2.5 border-b border-line px-4">
          <sk-icon name="search" class="text-[16px] text-dim" />
          <input
            #search
            class="flex-1 bg-transparent py-3.5 text-[14px] outline-none"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            [attr.aria-activedescendant]="matches().length ? 'palette-' + active() : null"
            [placeholder]="'Go to a page or a project' | t"
            [value]="query()"
            (input)="filter($any($event.target).value)"
            (keydown.arrowdown)="move($event, 1)"
            (keydown.arrowup)="move($event, -1)"
            (keydown.enter)="open(active())"
            (keydown.escape)="closed.emit()"
          />
          <span class="kbd text-dim">esc</span>
        </div>
        <ul id="palette-results" role="listbox" class="max-h-[360px] overflow-y-auto p-1.5">
          @for (entry of matches(); track $index) {
            <li
              role="option"
              [id]="'palette-' + $index"
              [attr.aria-selected]="$index === active()"
              class="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] text-fg3"
              [class.bg-sel]="$index === active()"
              [class.text-fg]="$index === active()"
              (mouseenter)="active.set($index)"
              (click)="open($index)"
              (keydown.enter)="open($index)"
              tabindex="-1"
            >
              <sk-icon [name]="entry.icon" class="text-[16px] text-dim" />
              <span class="flex-1">{{ entry.raw ? entry.label : (entry.label | t) }}</span>
            </li>
          } @empty {
            <li class="px-3 py-6 text-center text-[13px] text-mute2">
              {{ 'Nothing matches.' | t }}
            </li>
          }
        </ul>
      </div>
    </div>
  `,
})
export class CommandPalette {
  readonly entries = input.required<readonly PaletteEntry[]>();
  readonly closed = output();
  private readonly router = inject(Router);
  private readonly i18n = inject(I18n);
  private readonly search = viewChild.required<ElementRef<HTMLInputElement>>('search');
  protected readonly query = signal('');
  protected readonly active = signal(0);
  protected readonly matches = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.entries().filter(
      (entry) =>
        !q || (entry.raw ? entry.label : this.i18n.t(entry.label)).toLowerCase().includes(q),
    );
  });

  constructor() {
    afterNextRender(() => {
      this.search().nativeElement.focus();
    });
  }

  protected filter(value: string): void {
    this.query.set(value);
    this.active.set(0);
  }

  protected move(event: Event, step: number): void {
    event.preventDefault();
    const count = this.matches().length;
    if (count) this.active.set((this.active() + step + count) % count);
  }

  protected open(index: number): void {
    const entry = this.matches().at(index);
    if (!entry) return;
    this.closed.emit();
    void this.router.navigate(entry.link);
  }
}
