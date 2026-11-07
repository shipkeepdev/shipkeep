import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { SessionStore } from '../identity/session-store';
import { I18n, LANGUAGES, T } from '../ui/i18n';
import { Logo } from './logo';

/**
 * The frame of the pages that belong to no organization: choosing or creating one, and the
 * account. Same header as the sign-in screens, with links once signed in.
 */
@Component({
  selector: 'sk-public-frame',
  imports: [Logo, RouterLink, RouterLinkActive, RouterOutlet, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="skip-link" href="#main-content" (click)="skip($event)">{{ 'Skip to content' | t }}</a>
    <div class="flex min-h-dvh flex-col bg-black">
      <header
        class="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-[22px] py-3.5"
      >
        <a routerLink="/home" [attr.aria-label]="'Shipkeep home' | t"><sk-logo /></a>
        <div class="flex items-center gap-2.5">
          @if (session.profile()) {
            <nav class="flex gap-1 text-[13px]" [attr.aria-label]="'Account' | t">
              <a
                routerLink="/orgs"
                routerLinkActive="bg-sel text-fg"
                [routerLinkActiveOptions]="{ exact: true }"
                class="rounded-lg px-3 py-1.5 text-mute hover:text-fg"
                >{{ 'Organizations' | t }}</a
              >
              <a
                routerLink="/account"
                routerLinkActive="bg-sel text-fg"
                class="rounded-lg px-3 py-1.5 text-mute hover:text-fg"
                >{{ 'Account' | t }}</a
              >
            </nav>
          }
          <div
            class="flex overflow-hidden rounded-lg border border-white/16 text-[11px] font-medium"
          >
            @for (l of languages; track l) {
              <button
                type="button"
                class="px-[9px] py-[5px]"
                [class.bg-paper]="i18n.language() === l"
                [class.text-black]="i18n.language() === l"
                [class.text-fg3]="i18n.language() !== l"
                [attr.aria-pressed]="i18n.language() === l"
                (click)="i18n.use(l)"
              >
                {{ l.toUpperCase() }}
              </button>
            }
          </div>
        </div>
      </header>
      <main
        id="main-content"
        tabindex="-1"
        class="mx-auto flex w-full max-w-[960px] flex-1 flex-col px-5 py-10 max-sm:py-6"
      >
        <router-outlet />
      </main>
    </div>
  `,
})
export class PublicFrame {
  protected readonly session = inject(SessionStore);
  protected readonly i18n = inject(I18n);
  protected readonly languages = LANGUAGES;

  protected skip(event: Event): void {
    event.preventDefault();
    const main = (event.target as HTMLElement).ownerDocument.getElementById('main-content');
    main?.focus();
    main?.scrollIntoView();
  }
}
