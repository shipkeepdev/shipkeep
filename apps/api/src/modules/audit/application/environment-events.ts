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
/**
 * A client that cannot take what was written gets this long to catch up, then the stream ends.
 * Nothing new is read or written while it waits, and the next poll checks the session again before
 * anything else is sent, so revocation keeps ending the stream before new data reaches it.
 */
export const DRAIN_TIMEOUT_MS = 10_000;
/** Bytes a stream may leave queued for its client; above it the stream ends at once (#345). */
export const MAX_PENDING_BYTES = 64 * 1024;

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
 * How a stream ended: `slow` when its client could not keep up, which leaves data queued that the
 * caller should discard rather than wait for.
 */
export type PumpEnd = 'done' | 'slow';

/**
 * Writes new events until the client leaves, access ends or the lifetime is over. A failed poll
 * ends the stream instead of hiding the failure: the client reconnects and is checked again.
 *
 * `write` reports whether the client's buffer took the chunk; `pending` counts the bytes still
 * queued; `drained` waits, at most the given time, for the buffer to empty. A stream whose client
 * stops reading is paused (no poll, no write) until it drains, and ends as `slow` past the drain
 * timeout or the byte budget.
 */
export async function pumpEvents(input: {
  readonly after: string;
  readonly poll: (after: string) => Promise<readonly AuditRecord[]>;
  readonly write: (chunk: string) => boolean;
  readonly pending: () => number;
  readonly drained: (milliseconds: number, signal: AbortSignal) => Promise<boolean>;
  readonly signal: AbortSignal;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly now: () => number;
}): Promise<PumpEnd> {
  let cursor = input.after;
  const started = input.now();
  let wrote = started;
  // Read through a function: the signal changes during the awaits below.
  const left = () => input.signal.aborted;
  // Whether the client can take more: within the byte budget, and its buffer emptied in time.
  const keptUp = async (accepted: boolean) => {
    if (input.pending() > MAX_PENDING_BYTES) return false;
    return accepted || (await input.drained(DRAIN_TIMEOUT_MS, input.signal));
  };
  while (!left() && input.now() - started < STREAM_LIFETIME_MS) {
    await input.sleep(POLL_MS, input.signal);
    if (left()) return 'done';
    let events: readonly AuditRecord[];
    try {
      events = await input.poll(cursor);
    } catch {
      return 'done';
    }
    let accepted = true;
    for (const event of events) {
      accepted = input.write(serverSentEvent(event)) && accepted;
      cursor = event.id;
      wrote = input.now();
      if (input.pending() > MAX_PENDING_BYTES) return 'slow';
    }
    if (input.now() - wrote >= HEARTBEAT_MS) {
      accepted = input.write(': keep-alive\n\n') && accepted;
      wrote = input.now();
    }
    if (!(await keptUp(accepted))) return left() ? 'done' : 'slow';
  }
  return 'done';
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

  /**
   * The session, the account and the permission are checked on every call: signing out, a revoked
   * or expired session, or lost access ends the stream.
   */
  async poll(
    context: SecurityContext,
    target: EnvironmentTarget,
    after: string,
  ): Promise<AuditRecord[]> {
    const scope = {
      organizationId: target.organizationId,
      projectId: target.projectId,
      environmentId: target.environmentId,
    };
    await this.accounts.assertSessionLive(context);
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
