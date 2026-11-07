import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { ICONS, type IconName } from './icons';

/** A decorative outline icon: the text next to it carries the meaning. */
@Component({
  selector: 'sk-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="block size-[1em]"
    >
      @for (path of paths(); track $index) {
        <path [attr.d]="path" />
      }
    </svg>
  `,
  host: { class: 'inline-block shrink-0' },
})
export class Icon {
  readonly name = input.required<IconName>();
  protected readonly paths = computed(() => ICONS[this.name()]);
}
