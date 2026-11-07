import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';

export interface Tab {
  readonly id: string;
  readonly label: string;
}

/**
 * Sections of a page, shown one at a time. Hide the panels with `[hidden]` rather than removing
 * them, so that a form keeps what was typed when another tab is opened.
 */
@Component({
  selector: 'sk-tabs',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div role="tablist" [attr.aria-label]="label()" class="tabs">
      @for (tab of tabs(); track tab.id) {
        <button
          type="button"
          role="tab"
          class="tab"
          [id]="'tab-' + tab.id"
          [attr.aria-selected]="active() === tab.id"
          [attr.aria-controls]="'panel-' + tab.id"
          [attr.tabindex]="active() === tab.id ? 0 : -1"
          (click)="active.set(tab.id)"
          (keydown.arrowright)="move($event, 1)"
          (keydown.arrowleft)="move($event, -1)"
        >
          {{ tab.label }}
        </button>
      }
    </div>
  `,
})
export class Tabs {
  readonly tabs = input.required<readonly Tab[]>();
  readonly label = input.required<string>();
  readonly active = model.required<string>();

  protected move(event: Event, step: number): void {
    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.id === this.active());
    const next = tabs.at((index + step + tabs.length) % tabs.length);
    if (!next) return;
    this.active.set(next.id);
    const list = (event.target as HTMLElement).parentElement;
    list?.querySelector<HTMLElement>(`#tab-${next.id}`)?.focus();
  }
}
