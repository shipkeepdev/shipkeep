import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { BRANDS, type BrandName } from '../shell/brands';

/** A brand mark (Simple Icons), drawn in the current text color. Decorative: a name sits next to it. */
@Component({
  selector: 'sk-brand',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="currentColor"
    class="block size-full"
  >
    <path [attr.d]="path()" />
  </svg>`,
  host: { class: 'inline-block shrink-0' },
})
export class Brand {
  readonly name = input.required<BrandName>();
  protected readonly path = computed(() => BRANDS[this.name()]);
}
