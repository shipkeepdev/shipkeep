import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { shortDate } from '../dashboard/format';
import { I18n, T } from '../ui/i18n';

import { IdentityApi, IdentityRequestError, type IdentitySchema } from './identity-api';

type Session = IdentitySchema<'AccountSessionDto'>;

/**
 * Profile → Sessions (issue #253): where the account is signed in, and a way to end the others.
 * An ended session answers 401 at its next request; this one ends by signing out.
 */
@Component({
  selector: 'sk-sessions-panel',
  imports: [T],
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
      @if (problem(); as message) {
        <div class="alert" role="alert">{{ message | t }}</div>
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
                    [disabled]="busy()"
                    [attr.aria-label]="i18n.t('Sign out {device}', { device: device(s) })"
                    (click)="revoke(s)"
                  >
                    {{ 'Sign out' | t }}
                  </button>
                }
              </li>
            }
          </ul>
          @if (truncated()) {
            <p class="text-[12px] text-mute2">
              {{ 'These are the 100 most recently active sessions.' | t }}
            </p>
          }
          @if (sessions().length > 1 || truncated()) {
            <div>
              <button type="button" class="btn btn-sm" [disabled]="busy()" (click)="revokeOthers()">
                {{ 'Sign out every other session' | t }}
              </button>
            </div>
          }
        }
      }
    </div>
  `,
})
export class SessionsPanel {
  private readonly api = inject(IdentityApi);
  protected readonly i18n = inject(I18n);
  protected readonly state = signal<'loading' | 'failed' | 'ready'>('loading');
  protected readonly sessions = signal<readonly Session[]>([]);
  /** More live sessions than listed: "sign out every other session" ends them too. */
  protected readonly truncated = signal(false);
  protected readonly busy = signal(false);
  protected readonly problem = signal<string | null>(null);
  /** Only the latest load may answer: an older list never replaces a newer one. */
  #revision = 0;

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

  /**
   * Ends another session. The call sends no idempotency key, so nothing ties a later click to
   * an earlier attempt: a failure only says so, and a 404 means the session is already ended
   * (by an earlier attempt whose answer was lost). The list is read again either way.
   */
  /** Ends every other session at once, including those past the listed ones. */
  protected async revokeOthers(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.problem.set(null);
    try {
      await this.api.revokeOtherSessions();
    } catch {
      this.problem.set('The other sessions could not be signed out. Try again.');
    } finally {
      this.busy.set(false);
    }
    await this.load();
  }

  protected async revoke(session: Session): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.problem.set(null);
    try {
      await this.api.revokeSession(session.id);
    } catch (error) {
      if (!(error instanceof IdentityRequestError && error.status === 404))
        this.problem.set('The session could not be signed out. Try again.');
    } finally {
      this.busy.set(false);
    }
    await this.load();
  }

  private async load(): Promise<void> {
    const revision = ++this.#revision;
    try {
      const { items, truncated } = await this.api.sessions();
      if (revision !== this.#revision) return;
      this.sessions.set(items);
      this.truncated.set(truncated);
      this.state.set('ready');
    } catch {
      if (revision === this.#revision) this.state.set('failed');
    }
  }
}
