import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  model,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';

import { T } from '../ui/i18n';
import { Icon } from './icon';
import { type IconName } from './icons';

export interface Tab {
  readonly id: string;
  /** English source text. */
  readonly label: string;
  readonly icon?: IconName;
  readonly count?: string | number | null;
}

/**
 * Sections of a page, shown one at a time, as the design's underlined tabs. The open tab is kept in
 * the URL (`?tab=`), so a reload or a shared link opens the same one. Hide the panels with `[hidden]`
 * rather than removing them, so that a form keeps what was typed when another tab is opened.
 */
@Component({
  selector: 'sk-tabs',
  imports: [Icon, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div role="tablist" [attr.aria-label]="label() | t" class="tabbar">
      @for (tab of tabs(); track tab.id) {
        <button
          type="button"
          role="tab"
          [id]="'tab-' + tab.id"
          [attr.aria-selected]="active() === tab.id"
          [attr.aria-controls]="'panel-' + tab.id"
          [attr.tabindex]="active() === tab.id ? 0 : -1"
          (click)="select(tab.id)"
          (keydown.arrowright)="move($event, 1)"
          (keydown.arrowleft)="move($event, -1)"
        >
          @if (tab.icon) {
            <sk-icon [name]="tab.icon" />
          }
          {{ tab.label | t }}
          @if (tab.count) {
            <span class="text-[10.5px] text-dim">{{ tab.count }}</span>
          }
        </button>
      }
    </div>
  `,
})
export class Tabs {
  readonly tabs = input.required<readonly Tab[]>();
  readonly label = input.required<string>();
  readonly active = model.required<string>();
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly fromUrl = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('tab'))),
  );

  constructor() {
    effect(() => {
      const wanted = this.fromUrl();
      const known = this.tabs().some((tab) => tab.id === wanted);
      if (wanted && known && wanted !== untracked(this.active)) this.active.set(wanted);
    });
  }

  protected select(id: string): void {
    this.active.set(id);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: id },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected move(event: Event, step: number): void {
    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.id === this.active());
    const next = tabs.at((index + step + tabs.length) % tabs.length);
    if (!next) return;
    this.select(next.id);
    const list = (event.target as HTMLElement).parentElement;
    list?.querySelector<HTMLElement>(`#tab-${next.id}`)?.focus();
  }
}
