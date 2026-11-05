import { signal } from '@angular/core';

import { IdentityRequestError } from '../identity/identity-api';

/** A list loaded from the API, with a bounded, server-detail-free error message. */
export class Collection<T> {
  private readonly values = signal<readonly T[]>([]);
  private readonly status = signal<'loading' | 'ready' | 'failed'>('loading');
  private readonly failure = signal<string | null>(null);
  private revision = 0;
  readonly items = this.values.asReadonly();
  readonly state = this.status.asReadonly();
  readonly problem = this.failure.asReadonly();

  constructor(private readonly load: () => Promise<readonly T[]>) {}

  async refresh(): Promise<void> {
    const revision = ++this.revision;
    this.status.set('loading');
    try {
      const items = await this.load();
      if (revision !== this.revision) return;
      this.values.set(items);
      this.status.set('ready');
      this.failure.set(null);
    } catch (error: unknown) {
      if (revision !== this.revision) return;
      this.status.set('failed');
      this.failure.set(
        error instanceof IdentityRequestError ? error.message : 'This list could not be loaded.',
      );
    }
  }
}
