import { ChangeDetectionStrategy, Component } from '@angular/core';

/** The Shipkeep mark and wordmark from the brand kit. */
@Component({
  selector: 'sk-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg aria-hidden="true" viewBox="0 0 32 32" class="block size-[26px] shrink-0">
      <path d="M7 11V25H21M12 20L25 7M16 7H25V16" fill="none" stroke="#F2F2F3" stroke-width="5" />
      <path d="M7 11V25H21M12 20L25 7M16 7H25V16" fill="none" stroke="#000" stroke-width="2" />
    </svg>
    <span class="text-[17px] tracking-tight text-ink">shipkeep</span>
  `,
  host: { class: 'inline-flex items-center gap-2.5' },
})
export class Logo {}
