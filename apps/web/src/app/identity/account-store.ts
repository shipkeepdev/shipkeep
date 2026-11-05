import { inject, Injectable, signal } from '@angular/core';

import { MutationRunner } from './mutation-runner';
import { SessionStore } from './session-store';

@Injectable()
export class AccountStore {
  readonly session = inject(SessionStore);
  readonly submission = inject(MutationRunner);
  private readonly pending = signal(false);
  readonly signingOut = this.pending.asReadonly();

  async signOut(): Promise<string | null> {
    if (this.submission.busy() || this.submission.cooldown() || this.submission.restartRequired())
      return null;
    this.pending.set(true);
    try {
      const result = await this.submission.run({}, (key) => this.session.logout(key));
      return result.ok ? '/auth/login' : null;
    } finally {
      this.pending.set(false);
    }
  }
}
