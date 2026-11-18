import { inject, Injectable, signal } from '@angular/core';
import { type ResolveFn } from '@angular/router';

import { IdentityApi } from './identity-api';

/** The first sign-in screen waits this long for the answer, then shows as if email were sent. */
const PATIENCE_MS = 2000;

/**
 * What the sign-in screens may offer on this installation (ADR 0020). Without an answer they offer
 * everything: the server refuses what it cannot do, and says why.
 */
@Injectable({ providedIn: 'root' })
export class AuthOptions {
  private readonly api = inject(IdentityApi);
  private readonly sendsEmail = signal(true);
  #waited = false;
  #turn = 0;
  /** False only when the server said that this installation sends no email. */
  readonly email = this.sendsEmail.asReadonly();

  /**
   * Asks on every sign-in screen, so that email turned on later shows without a reload. Only the
   * first screen waits for the answer, and only once, even when that answer never came: the next
   * screens show what is known and take the answer when it arrives.
   */
  async refresh(): Promise<void> {
    const asked = this.ask();
    if (this.#waited) return;
    this.#waited = true;
    await asked;
  }

  private async ask(): Promise<void> {
    const turn = ++this.#turn;
    try {
      const { email } = await this.api.options();
      if (turn !== this.#turn) return;
      this.sendsEmail.set(email);
    } catch {
      // No answer: the screens keep what they show.
    }
  }
}

/** Holds a sign-in screen until it knows what to offer, so that no link appears and then goes. */
export const authOptions: ResolveFn<void> = () => {
  const options = inject(AuthOptions);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const patience = new Promise<void>((done) => {
    timer = setTimeout(done, PATIENCE_MS);
  });
  return Promise.race([options.refresh(), patience]).finally(() => {
    clearTimeout(timer);
  });
};
