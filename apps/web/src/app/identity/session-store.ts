import { inject, Injectable, signal } from '@angular/core';

import {
  IdentityApi,
  IdentityRequestError,
  type IdentitySchema,
  type SessionProfile,
} from './identity-api';

@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly api = inject(IdentityApi);
  private readonly current = signal<SessionProfile | null>(null);
  private readonly status = signal<'loading' | 'anonymous' | 'authenticated' | 'unavailable'>(
    'loading',
  );
  private revision = 0;
  readonly profile = this.current.asReadonly();
  readonly state = this.status.asReadonly();

  async refresh(): Promise<void> {
    const revision = ++this.revision;
    this.status.set('loading');
    try {
      const profile = await this.api.session();
      if (revision === this.revision) this.accept(profile);
    } catch (error: unknown) {
      if (revision !== this.revision) return;
      this.current.set(null);
      this.status.set(
        error instanceof IdentityRequestError && error.status === 401 ? 'anonymous' : 'unavailable',
      );
    }
  }
  async login(body: IdentitySchema<'LoginCredentialsDto'>, key: string): Promise<void> {
    const revision = ++this.revision;
    const profile = await this.api.login(body, key);
    if (revision === this.revision) this.accept(profile);
  }
  async logout(key: string): Promise<void> {
    const revision = ++this.revision;
    try {
      await this.api.logout(key);
      if (revision === this.revision) this.clear();
    } catch (error: unknown) {
      if (revision === this.revision)
        this.status.set(this.current() ? 'authenticated' : 'unavailable');
      throw error;
    }
  }
  /** Security responses may also contain private grants. Retain only these three public fields. */
  accept(profile: SessionProfile): void {
    ++this.revision;
    this.current.set({
      userId: profile.userId,
      email: profile.email,
      expiresAt: profile.expiresAt,
    });
    this.status.set('authenticated');
  }
  clear(): void {
    ++this.revision;
    this.current.set(null);
    this.status.set('anonymous');
  }
}
