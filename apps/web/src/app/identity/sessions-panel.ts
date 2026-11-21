import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { shortDate } from '../dashboard/format';
import { I18n, T } from '../ui/i18n';

import { IdentityApi, type IdentitySchema } from './identity-api';
import { MutationRunner } from './mutation-runner';

type Session = IdentitySchema<'AccountSessionDto'>;

/**
 * Profile → Sessions (issue #253): where the account is signed in, and a way to end the others.
 * An ended session answers 401 at its next request; this one ends by signing out.
 */
@Component({
  selector: 'sk-sessions-panel',
  imports: [T],
  providers: [MutationRunner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-3">
      <div>
        <p class="text-[12.5px] text-mute2">
          {{
            'Where your account is signed in. Signing out another session ends it at its next request.'
              | t
          }}
        </p>
      </div>
      @if (runner.problem(); as problem) {
        <div class="alert" role="alert">{{ problem | t }}</div>
      }
      @switch (state()) {
        @case ('loading') {
          <p class="text-[12.5px] text-mute" role="status">{{ 'Loading…' | t }}</p>
        }
        @case ('failed') {
          <p class="text-[12.5px] text-mute" role="status">
            {{ 'Sessions could not be read. Reload the page to try again.' | t }}
          </p>
        }
        @default {
          <ul class="m-0 flex list-none flex-col p-0" [attr.aria-label]="'Sessions' | t">
            @for (s of sessions(); track s.id) {
              <li
                class="flex flex-wrap items-center justify-between gap-3 border-t border-line2 py-3 first:border-t-0"
              >
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2 text-[13px]">
                    {{ device(s) }}
                    @if (s.current) {
                      <span class="pill text-[11px]">{{ 'This device' | t }}</span>
                    }
                  </div>
                  <div class="mt-0.5 text-[11.5px] text-mute2">
                    <span class="font-mono">{{ s.ip }}</span> ·
                    {{ 'last active {at}' | t: { at: when(s.lastSeenAt) } }} ·
                    {{ 'signed in {at}' | t: { at: when(s.createdAt) } }}
                  </div>
                </div>
                @if (!s.current) {
                  <button
                    type="button"
                    class="btn btn-sm"
                    [disabled]="runner.busy() || !!runner.cooldown()"
                    [attr.aria-label]="i18n.t('Sign out {device}', { device: device(s) })"
                    (click)="revoke(s)"
                  >
                    {{ 'Sign out' | t }}
                  </button>
                }
              </li>
            }
          </ul>
        }
      }
    </div>
  `,
})
export class SessionsPanel {
  private readonly api = inject(IdentityApi);
  protected readonly runner = inject(MutationRunner);
  protected readonly i18n = inject(I18n);
  protected readonly state = signal<'loading' | 'failed' | 'ready'>('loading');
  protected readonly sessions = signal<readonly Session[]>([]);

  constructor() {
    void this.load();
  }

  /** "Firefox on Linux", in the interface language; the API gives known names only. */
  protected device(session: Session): string {
    const { browser, system } = session;
    if (browser && system) return this.i18n.t('{browser} on {system}', { browser, system });
    return browser ?? system ?? this.i18n.t('Unknown device');
  }

  protected when(at: string): string {
    return shortDate(at);
  }

  protected async revoke(session: Session): Promise<void> {
    const outcome = await this.runner.run({ revokeSession: session.id }, () =>
      this.api.revokeSession(session.id),
    );
    if (outcome.ok) await this.load();
  }

  private async load(): Promise<void> {
    try {
      this.sessions.set(await this.api.sessions());
      this.state.set('ready');
    } catch {
      this.state.set('failed');
    }
  }
}
