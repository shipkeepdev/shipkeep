import { ChangeDetectionStrategy, Component, inject, Injectable, signal } from '@angular/core';

import { Icon } from '../shell/icon';
import { T } from './i18n';

/**
 * A short message at the bottom of the screen. Buttons whose feature is not built yet stay in place,
 * as the design shows them, and say so here instead of doing nothing.
 */
@Injectable({ providedIn: 'root' })
export class Notice {
  readonly message = signal<{
    readonly text: string;
    readonly feature: string;
    readonly values?: Readonly<Record<string, string>>;
  } | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** `text` is English source text; `feature` is a label shown in front of it, translated too. */
  show(text: string, feature = '', values?: Readonly<Record<string, string>>): void {
    clearTimeout(this.timer);
    this.message.set({ text, feature, values });
    this.timer = setTimeout(() => {
      this.message.set(null);
    }, 6000);
  }

  notYet(feature = ''): void {
    this.show('Not available yet: this part of Shipkeep is still being built.', feature);
  }

  close(): void {
    clearTimeout(this.timer);
    this.message.set(null);
  }
}

@Component({
  selector: 'sk-notice',
  imports: [Icon, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      aria-live="polite"
      class="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4"
    >
      @if (notice.message(); as message) {
        <div
          class="pointer-events-auto flex max-w-[520px] items-start gap-2.5 rounded-xl border border-ctl2 bg-sel px-4 py-3 text-[13px] leading-normal text-fg2 shadow-[0_12px_40px_rgb(0_0_0/60%)]"
        >
          <sk-icon name="info-circle" class="mt-px text-[16px] text-mute" />
          <span class="flex-1">
            @if (message.feature) {
              <span class="text-fg">{{ message.feature | t }}</span> ·
            }
            {{ message.text | t: message.values }}</span
          >
          <button type="button" class="text-dim hover:text-fg" (click)="notice.close()">
            <sk-icon name="x" class="text-[15px]" /><span class="sr-only">{{ 'Close' | t }}</span>
          </button>
        </div>
      }
    </div>
  `,
})
export class NoticeHost {
  protected readonly notice = inject(Notice);
}
