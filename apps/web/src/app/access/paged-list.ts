import { signal } from '@angular/core';

import { IdentityRequestError } from '../identity/identity-api';

interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
const message = (error: unknown): string =>
  error instanceof IdentityRequestError ? error.message : 'This list could not be loaded.';

/** A cursor-paged list. A failed extension keeps what is shown; stale answers are dropped. */
export class PagedList<T> {
  private readonly loaded = signal<readonly T[]>([]);
  private readonly cursor = signal<string | null>(null);
  private readonly status = signal<'loading' | 'ready' | 'failed'>('loading');
  private readonly failure = signal<string | null>(null);
  private readonly extending = signal(false);
  private readonly refused = signal(false);
  private revision = 0;
  readonly items = this.loaded.asReadonly();
  readonly state = this.status.asReadonly();
  readonly problem = this.failure.asReadonly();
  readonly loadingMore = this.extending.asReadonly();
  /** The API hides what the caller may not manage: a panel for it has nothing to offer. */
  readonly denied = this.refused.asReadonly();
  readonly hasMore = (): boolean => this.cursor() !== null;

  constructor(private readonly load: (cursor?: string) => Promise<Page<T>>) {}

  async refresh(): Promise<void> {
    const revision = ++this.revision;
    this.status.set('loading');
    this.extending.set(false);
    try {
      const page = await this.load();
      if (revision !== this.revision) return;
      this.loaded.set(page.items);
      this.cursor.set(page.nextCursor);
      this.failure.set(null);
      this.refused.set(false);
      this.status.set('ready');
    } catch (error: unknown) {
      if (revision !== this.revision) return;
      this.loaded.set([]);
      this.cursor.set(null);
      this.failure.set(message(error));
      this.refused.set(error instanceof IdentityRequestError && [403, 404].includes(error.status));
      this.status.set('failed');
    }
  }

  /**
   * Reloads the newest page and keeps the older pages already opened: fresh items replace their
   * old copies by key. When the newest page no longer reaches what is shown, so items in between
   * would be missing, it falls back to a full refresh.
   */
  async refreshFirst(key: (item: T) => string): Promise<void> {
    const shown = this.loaded();
    if (this.status() !== 'ready' || !shown.length) {
      await this.refresh();
      return;
    }
    const revision = ++this.revision;
    this.extending.set(false);
    let gap = false;
    try {
      const page = await this.load();
      if (revision !== this.revision) return;
      const fresh = new Set(page.items.map(key));
      gap = page.nextCursor !== null && !shown.some((item) => fresh.has(key(item)));
      if (page.nextCursor === null) {
        // The newest page is now the whole list.
        this.loaded.set(page.items);
        this.cursor.set(null);
      } else if (!gap) {
        this.loaded.set([...page.items, ...shown.filter((item) => !fresh.has(key(item)))]);
      }
      this.failure.set(null);
    } catch (error: unknown) {
      if (revision === this.revision) this.failure.set(message(error));
    }
    if (gap) await this.refresh();
  }

  async more(): Promise<void> {
    const cursor = this.cursor();
    if (cursor === null || this.extending()) return;
    const revision = this.revision;
    this.extending.set(true);
    this.failure.set(null);
    try {
      const page = await this.load(cursor);
      if (revision !== this.revision) return;
      this.loaded.update((items) => [...items, ...page.items]);
      this.cursor.set(page.nextCursor);
    } catch (error: unknown) {
      if (revision === this.revision) this.failure.set(message(error));
    } finally {
      if (revision === this.revision) this.extending.set(false);
    }
  }
}
