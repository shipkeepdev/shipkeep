import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * The Shipkeep mark and wordmark, as the landing page draws them: two chevrons, the lower one
 * fainter, and the name in spaced capitals.
 */
@Component({
  selector: 'sk-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg aria-hidden="true" viewBox="0 0 32 32" class="block size-[26px] shrink-0">
      <path
        d="M5 21 L16 10 L27 21"
        fill="none"
        stroke="#F2F2F3"
        stroke-width="4.2"
        stroke-linecap="square"
      />
      <path
        d="M5 29 L16 18 L27 29"
        fill="none"
        stroke="#F2F2F3"
        stroke-width="4.2"
        stroke-linecap="square"
        opacity="0.45"
      />
    </svg>
    <span class="text-[15px] font-semibold tracking-[0.16em] text-ink uppercase">Shipkeep</span>
  `,
  host: { class: 'inline-flex items-center gap-2.5' },
})
export class Logo {}
