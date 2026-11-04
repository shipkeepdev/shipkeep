import { DestroyRef, inject, Injectable, signal } from '@angular/core';

import { IdentityRequestError, newMutationKey } from './identity-api';

class ExpiredAttemptError extends Error {
  constructor() {
    super('The previous result is uncertain. Start again before submitting a new request.');
  }
}

/** Component lifetime only. Native private fields keep credentials out of object serialization. */
export class MutationAttempt {
  #body: string | undefined;
  #key: string | undefined;
  #started = 0;

  keyFor(body: unknown, now = Date.now()): string {
    const serialized = JSON.stringify(body);
    if (this.#key && this.#body === serialized) {
      // The server's cache lasts five minutes. Leave one minute for transport and clock variation.
      if (now < this.#started || now - this.#started >= 240000) throw new ExpiredAttemptError();
      return this.#key;
    }
    this.#body = serialized;
    this.#started = now;
    this.#key = newMutationKey();
    return this.#key;
  }

  reset(): void {
    this.#body = undefined;
    this.#key = undefined;
    this.#started = 0;
  }
}

type Outcome<T> = { ok: true; value: T } | { ok: false };

/** Provide on a form, never at root: retries and private snapshots end with that form. */
@Injectable()
export class MutationRunner {
  #attempt = new MutationAttempt();
  #revision = 0;
  #destroyed = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  private readonly pending = signal(false);
  private readonly failure = signal<string | null>(null);
  private readonly remaining = signal(0);
  private readonly restart = signal(false);
  readonly busy = this.pending.asReadonly();
  readonly problem = this.failure.asReadonly();
  readonly cooldown = this.remaining.asReadonly();
  readonly restartRequired = this.restart.asReadonly();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.#destroyed = true;
      this.reset();
      clearInterval(this.#timer);
    });
  }

  async run<T>(body: unknown, operation: (key: string) => Promise<T>): Promise<Outcome<T>> {
    if (this.#destroyed || this.busy() || this.cooldown() || this.restartRequired())
      return { ok: false };
    const revision = ++this.#revision;
    this.pending.set(true);
    this.failure.set(null);
    try {
      const value = await operation(this.#attempt.keyFor(body));
      if (revision !== this.#revision) return { ok: false };
      this.#attempt.reset();
      return { ok: true, value };
    } catch (error: unknown) {
      if (revision !== this.#revision) return { ok: false };
      if (error instanceof ExpiredAttemptError) {
        this.failure.set(error.message);
        this.restart.set(true);
      } else if (error instanceof IdentityRequestError) {
        this.failure.set(error.message);
        this.restart.set(error.status === 409);
        // A transport/server timeout can occur after the command committed; preserve its key.
        if (error.status >= 400 && error.status < 500 && ![408, 409].includes(error.status))
          this.#attempt.reset();
        this.wait(error.retryAfterSeconds);
      } else {
        this.failure.set('This request could not be completed. Try again shortly.');
      }
      return { ok: false };
    } finally {
      if (revision === this.#revision) this.pending.set(false);
    }
  }

  reset(): void {
    ++this.#revision;
    this.#attempt.reset();
    this.pending.set(false);
    this.failure.set(null);
    this.restart.set(false);
    // Starting over never bypasses an outstanding server-requested wait.
  }

  private wait(seconds: number): void {
    const duration = Number.isFinite(seconds) ? Math.max(0, Math.min(3600, Math.ceil(seconds))) : 0;
    if (!duration) return;
    clearInterval(this.#timer);
    this.remaining.set(duration);
    const until = Date.now() + duration * 1000;
    this.#timer = setInterval(() => {
      this.remaining.set(Math.max(0, Math.min(duration, Math.ceil((until - Date.now()) / 1000))));
      if (!this.remaining()) clearInterval(this.#timer);
    }, 1000);
  }
}
