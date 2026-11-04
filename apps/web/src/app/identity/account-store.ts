import { inject, Injectable } from '@angular/core';

import { MutationRunner } from './mutation-runner';
import { SessionStore } from './session-store';

@Injectable()
export class AccountStore {
  readonly session = inject(SessionStore);
  readonly submission = inject(MutationRunner);

  async signOut(): Promise<string | null> {
    const result = await this.submission.run({}, (key) => this.session.logout(key));
    return result.ok ? '/auth/login' : null;
  }
}
