import { signal } from '@angular/core';

import { IdentityRequestError } from '../identity/identity-api';

interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
const isDenied = (error: unknown): boolean =>
  error instanceof IdentityRequestError && [403, 404].includes(error.status);
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
  /** Newest-page reloads; only the latest one applies. */
  private head = 0;
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
      if (revision === this.revision) this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.loaded.set([]);
    this.cursor.set(null);
    this.failure.set(message(error));
    this.refused.set(isDenied(error));
    this.status.set('failed');
  }

  /**
   * Reloads the newest page and keeps the older pages already opened: fresh items replace their
   * old copies by key. The merge uses the list as it is when the answer arrives, so an older page
   * appended meanwhile stays. When the newest page no longer reaches what is shown, so items in
   * between would be missing, it falls back to a full refresh. Losing access clears the list as
   * `refresh` does; other failures keep what is shown.
   */
  async refreshFirst(key: (item: T) => string): Promise<void> {
    if (this.status() !== 'ready' || !this.loaded().length) {
      await this.refresh();
      return;
    }
    const revision = this.revision;
    const head = ++this.head;
    const current = (): boolean => revision === this.revision && head === this.head;
    try {
      const page = await this.load();
      if (!current()) return;
      const shown = this.loaded();
      const fresh = new Set(page.items.map(key));
      if (page.nextCursor === null) {
        // The newest page is now the whole list.
        this.loaded.set(page.items);
        this.cursor.set(null);
      } else if (shown.some((item) => fresh.has(key(item)))) {
        this.loaded.set([...page.items, ...shown.filter((item) => !fresh.has(key(item)))]);
      } else {
        await this.refresh();
        return;
      }
      this.failure.set(null);
    } catch (error: unknown) {
      if (!current()) return;
      if (isDenied(error)) this.fail(error);
      else this.failure.set(message(error));
    }
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
