import { inject, Injectable, signal } from '@angular/core';

import { IdentityRequestError } from '../identity/identity-api';

import { AuditApi, type AuditEvent, type AuditExport, type AuditQuery } from './audit-api';

const message = (error: unknown, fallback: string): string =>
  error instanceof IdentityRequestError ? error.message : fallback;

/** One organization's audit events: the applied filters, loaded pages and the export. */
@Injectable()
export class AuditLogStore {
  private readonly api = inject(AuditApi);
  private readonly loaded = signal<readonly AuditEvent[]>([]);
  private readonly cursor = signal<string | null>(null);
  private readonly status = signal<'loading' | 'ready' | 'failed'>('loading');
  private readonly failure = signal<string | null>(null);
  private readonly applied = signal<AuditQuery>({});
  private readonly extending = signal(false);
  private readonly exportFailure = signal<string | null>(null);
  private readonly exportRunning = signal(false);
  private organizationId = '';
  /** Answers to a previous organization or filter set are dropped when they arrive. */
  private revision = 0;

  readonly events = this.loaded.asReadonly();
  readonly state = this.status.asReadonly();
  readonly problem = this.failure.asReadonly();
  readonly query = this.applied.asReadonly();
  readonly loadingMore = this.extending.asReadonly();
  readonly exporting = this.exportRunning.asReadonly();
  readonly exportProblem = this.exportFailure.asReadonly();
  readonly hasMore = (): boolean => this.cursor() !== null;

  async open(organizationId: string, query: AuditQuery): Promise<void> {
    const revision = ++this.revision;
    this.organizationId = organizationId;
    this.applied.set(query);
    this.status.set('loading');
    this.extending.set(false);
    this.exportFailure.set(null);
    try {
      const page = await this.api.page(organizationId, query);
      if (revision !== this.revision) return;
      this.loaded.set(page.items);
      this.cursor.set(page.nextCursor);
      this.failure.set(null);
      this.status.set('ready');
    } catch (error: unknown) {
      if (revision !== this.revision) return;
      this.loaded.set([]);
      this.cursor.set(null);
      this.failure.set(message(error, 'The audit log could not be loaded.'));
      this.status.set('failed');
    }
  }

  /** A failure keeps the events already shown; the button stays so it can be retried. */
  async more(): Promise<void> {
    const cursor = this.cursor();
    if (cursor === null || this.extending()) return;
    const revision = this.revision;
    this.extending.set(true);
    this.failure.set(null);
    try {
      const page = await this.api.page(this.organizationId, this.applied(), cursor);
      if (revision !== this.revision) return;
      this.loaded.update((events) => [...events, ...page.items]);
      this.cursor.set(page.nextCursor);
    } catch (error: unknown) {
      if (revision !== this.revision) return;
      this.failure.set(message(error, 'More events could not be loaded.'));
    } finally {
      if (revision === this.revision) this.extending.set(false);
    }
  }

  /** Exports what the applied filters select, not what is typed but not yet applied. */
  async export(): Promise<AuditExport | null> {
    this.exportRunning.set(true);
    this.exportFailure.set(null);
    try {
      return await this.api.export(this.organizationId, this.applied());
    } catch (error: unknown) {
      this.exportFailure.set(message(error, 'The audit log could not be exported.'));
      return null;
    } finally {
      this.exportRunning.set(false);
    }
  }
}
