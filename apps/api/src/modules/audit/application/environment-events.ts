import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import type { ResourceSecurityContext as SecurityContext } from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import type { AuditRecord } from '../domain/audit-record';

import { AUDIT_EVENT_READER, type AuditEventReader } from './audit-event-reader';

export const POLL_MS = 2000;
export const HEARTBEAT_MS = 15_000;
/** Streams end after this long; the browser reconnects, which authenticates from scratch. */
export const STREAM_LIFETIME_MS = 3600_000;
const MAX_STREAMS_PER_ACCOUNT = 8;
const BATCH = 100;

export interface EnvironmentTarget {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

/** What a stream reveals of an audit event: enough to know what to reload, no metadata. */
export function serverSentEvent(record: AuditRecord): string {
  const applicationId = record.metadata['applicationId'];
  const data = JSON.stringify({
    type: record.action,
    targetType: record.targetType,
    targetId: record.targetId,
    ...(typeof applicationId === 'string' ? { applicationId } : {}),
    at: record.createdAt.toISOString(),
  });
  return `id: ${record.id}\nevent: change\ndata: ${data}\n\n`;
}

/**
 * Writes new events until the client leaves, access ends or the lifetime is over. A failed poll
 * ends the stream instead of hiding the failure: the client reconnects and is checked again.
 */
export async function pumpEvents(input: {
  readonly after: string;
  readonly poll: (after: string) => Promise<readonly AuditRecord[]>;
  readonly write: (chunk: string) => void;
  readonly signal: AbortSignal;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now: () => number;
}): Promise<void> {
  let cursor = input.after;
  const started = input.now();
  let wrote = started;
  // Read through a function: the signal changes during the awaits below.
  const left = () => input.signal.aborted;
  while (!left() && input.now() - started < STREAM_LIFETIME_MS) {
    await input.sleep(POLL_MS, input.signal);
    if (left()) return;
    let events: readonly AuditRecord[];
    try {
      events = await input.poll(cursor);
    } catch {
      return;
    }
    for (const event of events) {
      input.write(serverSentEvent(event));
      cursor = event.id;
      wrote = input.now();
    }
    if (input.now() - wrote >= HEARTBEAT_MS) {
      input.write(': keep-alive\n\n');
      wrote = input.now();
    }
  }
}

/**
 * Tells browsers what changed in an environment (SPEC 8, PLAN M2.6b), by following its committed
 * audit events: the event bus publishes before commit, so it could announce a rolled-back change.
 * Events are hints to reload through the normal API. Clients keep a slow fallback poll, because a
 * transaction committing late can carry an older id than the stream's cursor.
 */
@Injectable()
export class EnvironmentEvents implements OnApplicationShutdown {
  private readonly open = new Map<string, number>();
  private readonly streams = new Set<AbortController>();

  constructor(
    @Inject(AUDIT_EVENT_READER) private readonly reader: AuditEventReader,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
  ) {}

  /** The live session and permission are checked on every call: revocation ends the stream. */
  poll(context: SecurityContext, target: EnvironmentTarget, after: string): Promise<AuditRecord[]> {
    const scope = {
      organizationId: target.organizationId,
      projectId: target.projectId,
      environmentId: target.environmentId,
    };
    return this.accounts.run(
      context,
      async () => {
        await this.access.require(context.userId, 'environment.read', scope);
        return this.reader.afterInEnvironment(
          target.organizationId,
          target.environmentId,
          after,
          BATCH,
        );
      },
      { permission: 'environment.read', target: scope },
    );
  }

  /** Runs `work` as one of the account's bounded streams, stopped when the API shuts down. */
  async run(accountId: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const count = this.open.get(accountId) ?? 0;
    if (count >= MAX_STREAMS_PER_ACCOUNT)
      throw new HttpException('Too many open event streams.', HttpStatus.TOO_MANY_REQUESTS);
    const controller = new AbortController();
    this.open.set(accountId, count + 1);
    this.streams.add(controller);
    try {
      await work(controller.signal);
    } finally {
      this.streams.delete(controller);
      const remaining = (this.open.get(accountId) ?? 1) - 1;
      if (remaining > 0) this.open.set(accountId, remaining);
      else this.open.delete(accountId);
    }
  }

  /** Open streams would otherwise hold the HTTP server open during shutdown. */
  onApplicationShutdown(): void {
    for (const stream of this.streams) stream.abort();
  }
}
