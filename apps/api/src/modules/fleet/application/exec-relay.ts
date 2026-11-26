import { Inject, Injectable, Logger } from '@nestjs/common';
import { createEvent, type DomainEvent, SYSTEM_ACTOR } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import {
  AUDIT_EVENT_READER,
  type AuditEventReader,
} from '../../audit/application/audit-event-reader';

import { FLEET_TRANSACTION, type FleetTransaction } from './ports';

/** A session waiting for the browser and the agent to join it, then relayed between them. */
export interface ExecSession {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly applicationId: string;
  readonly userId: string;
  readonly nodeId: string;
  readonly container: string;
  readonly tty: boolean;
  /** Until when the browser and the agent may join. */
  readonly attachBy: Date;
  /** When the agent ends it, whatever happens. */
  readonly endsAt: Date;
}

/** What the agent sends: output, then one exit or error. */
export type AgentFrame =
  | { readonly kind: 'stdout' | 'stderr'; readonly data: Uint8Array }
  | { readonly kind: 'exit'; readonly code: number }
  | { readonly kind: 'error'; readonly message: string };

/** What the browser sends: input, a terminal size, or the end of input or of the session. */
export type BrowserFrame =
  | { readonly kind: 'stdin'; readonly data: Uint8Array }
  | { readonly kind: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly kind: 'close'; readonly kill: boolean };

/**
 * The browser's connection, as the relay sees it. `send` resolves once the frame is written;
 * `close` tells why the session ended, then closes.
 */
export interface BrowserPort {
  send(frame: AgentFrame): Promise<void>;
  close(reason: ExecEnd): void;
}

/** Why a session ended, as the audit log records it. */
export type ExecEnd =
  | 'exited'
  | 'time_limit'
  | 'closed'
  | 'failed'
  | 'not_joined'
  | 'agent_left'
  | 'browser_left'
  | 'flooded'
  | 'signed_out'
  | 'access_removed'
  | 'shutdown';

/** The agent's fixed error texts (agent/internal/actions/exec.go), and what they mean. */
const AGENT_ERRORS: ReadonlyMap<string, ExecEnd> = new Map([
  ['time limit reached', 'time_limit'],
  ['session closed', 'closed'],
  ['session failed', 'failed'],
]);
/** How long past its time limit the control plane waits for the agent to end a session. */
export const EXEC_END_GRACE_MS = 30_000;

/** The end an agent's error frame says, from its fixed texts; any other text is a failure. */
export function execEndOf(message: string): ExecEnd {
  return AGENT_ERRORS.get(message) ?? 'failed';
}

/** Frames from the browser that may wait for the agent; past this the session is flooded. */
export const MAX_WAITING_FRAMES = 256;

type EndHandler = (relay: ExecRelay, end: ExecEnd, exitCode: number | null, ms: number) => void;

/**
 * One session's relay: the rendezvous of its two sides, then frames between them until one end.
 * It never interprets output: it is the application's, sent as it came.
 */
export class ExecRelay {
  private browser: BrowserPort | undefined;
  private agentJoined = false;
  private ended: ExecEnd | undefined;
  /** The agent's exit or error, kept from its arrival: an end meanwhile does not replace it. */
  private outcome: { reason: ExecEnd; exitCode: number | null } | undefined;
  private startedAt: number | undefined;
  private readonly waiting: BrowserFrame[] = [];
  private wake: (() => void) | undefined;
  private settle: ((both: boolean) => void) | undefined;
  private readonly joined: Promise<boolean>;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly limit: ReturnType<typeof setTimeout>;

  constructor(
    readonly session: ExecSession,
    private readonly onEnd: EndHandler,
    now: Date,
  ) {
    this.joined = new Promise((resolve) => (this.settle = resolve));
    this.timer = setTimeout(
      () => {
        if (!this.browser || !this.agentJoined) this.end('not_joined', null);
      },
      Math.max(session.attachBy.getTime() - now.getTime(), 0),
    );
    this.timer.unref();
    // The agent ends a session at its time limit; one that does not is ended here, after a grace.
    this.limit = setTimeout(
      () => {
        this.end('time_limit', null);
      },
      Math.max(session.endsAt.getTime() - now.getTime() + EXEC_END_GRACE_MS, 0),
    );
    this.limit.unref();
  }

  /** The agent joins once; false when it may not (already joined or ended). */
  joinAgent(): boolean {
    if (this.agentJoined || this.ended) return false;
    this.agentJoined = true;
    this.start();
    return true;
  }

  /** The browser joins once; false when it may not. */
  joinBrowser(port: BrowserPort): boolean {
    if (this.browser || this.ended) return false;
    this.browser = port;
    this.start();
    return true;
  }

  /** Resolves true once both sides joined, false if the session ended first. */
  bothJoined(): Promise<boolean> {
    return this.joined;
  }

  /** A frame from the agent, forwarded to the browser; exit and error end the session. */
  async fromAgent(frame: AgentFrame): Promise<void> {
    if (this.ended || !this.browser) return;
    if (frame.kind === 'exit') this.outcome = { reason: 'exited', exitCode: frame.code };
    else if (frame.kind === 'error')
      this.outcome = { reason: execEndOf(frame.message), exitCode: null };
    await this.browser.send(frame);
    if (this.outcome) this.end(this.outcome.reason, this.outcome.exitCode);
  }

  /** A frame from the browser, queued for the agent. */
  fromBrowser(frame: BrowserFrame): void {
    if (this.ended) return;
    if (this.waiting.length >= MAX_WAITING_FRAMES) {
      this.end('flooded', null);
      return;
    }
    this.waiting.push(frame);
    this.wake?.();
  }

  /** The frames for the agent, until the session ends; the last one stops its command. */
  async *toAgent(): AsyncGenerator<BrowserFrame> {
    for (;;) {
      const frame = this.waiting.shift();
      if (frame) {
        yield frame;
        continue;
      }
      if (this.ended) break;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
    // Whatever ended the session, the agent stops the command it may still run.
    if (this.ended !== 'exited') yield { kind: 'close', kill: true };
  }

  /** The agent's stream ended. */
  agentLeft(): void {
    this.end('agent_left', null);
  }

  /** The browser's connection closed. */
  browserLeft(): void {
    this.end('browser_left', null);
  }

  /** Whether the browser joined. */
  get browserJoined(): boolean {
    return this.browser !== undefined;
  }

  /** Whether the session ended. */
  get over(): boolean {
    return this.ended !== undefined;
  }

  /** Ends the session once: both sides are released and the end is recorded. */
  end(reason: ExecEnd, exitCode: number | null): void {
    if (this.ended) return;
    // An exit already received is the session's end, whatever closes it during its delivery.
    if (this.outcome) ({ reason, exitCode } = this.outcome);
    this.ended = reason;
    // Input not sent yet is dropped, whatever the end: a person who lost access or signed out,
    // or a browser that left, sends nothing more, and the agent's next frame stops the command.
    this.waiting.length = 0;
    clearTimeout(this.timer);
    clearTimeout(this.limit);
    this.settle?.(false);
    this.wake?.();
    this.browser?.close(reason);
    const started = this.startedAt;
    this.onEnd(this, reason, exitCode, started === undefined ? 0 : Date.now() - started);
  }

  private start(): void {
    if (!this.browser || !this.agentJoined) return;
    this.startedAt = Date.now();
    this.settle?.(true);
  }
}

/** A closing audit write that failed is tried again, the delay doubling from 1 s up to 1 min. */
const CLOSE_RETRY_FIRST_MS = 1000;
const CLOSE_RETRY_MAX_MS = 60_000;
/** About 15 minutes of attempts: beyond that, the session's check records it interrupted. */
const CLOSE_ATTEMPTS = 20;
/** The audit actions that close a session: one of them, once, ends its lifecycle (issue #489). */
export const EXEC_SESSION_CLOSINGS: ReadonlySet<string> = new Set([
  'exec.session.ended',
  'exec.session.interrupted',
]);

/**
 * Sessions opened on this API process. A session lives only as long as both its connections,
 * which both reach this process, so it is never stored: a restart ends it, and the agent's
 * action ends with its stream. Each end is audited as `exec.session.ended`.
 */
@Injectable()
export class ExecSessionRegistry {
  private readonly logger = new Logger(ExecSessionRegistry.name);
  private readonly relays = new Map<string, ExecRelay>();
  private readonly writes = new Set<Promise<void>>();
  private readonly reserved: { userId: string; organizationId: string }[] = [];

  constructor(
    @Inject(FLEET_TRANSACTION) private readonly transaction: FleetTransaction,
    private readonly events: DomainEventBus,
    @Inject(AUDIT_EVENT_READER) private readonly audit: AuditEventReader,
  ) {}

  /** Whether the session's closing is recorded already, as an end or an interruption. */
  async closed(session: { id: string; organizationId: string }): Promise<boolean> {
    const records = await this.audit.page(
      session.organizationId,
      { targetType: 'exec_session', targetId: session.id },
      undefined,
      10,
    );
    return records.some((record) => EXEC_SESSION_CLOSINGS.has(record.action));
  }

  add(session: ExecSession, now = new Date()): void {
    const relay = new ExecRelay(
      session,
      (ended, reason, code, ms) => {
        this.ended(ended, reason, code, ms);
      },
      now,
    );
    this.relays.set(session.id, relay);
  }

  /**
   * Holds a place for a session being opened, counted at once: two opens at the same time cannot
   * both pass the caps. The release gives it back, once the session is added or failed.
   */
  reserve(owner: { userId: string; organizationId: string }): () => void {
    const place = { ...owner };
    this.reserved.push(place);
    return () => {
      const index = this.reserved.indexOf(place);
      if (index >= 0) this.reserved.splice(index, 1);
    };
  }

  /** Sessions of this person or organization being opened, waiting to be joined, or running. */
  count(owner: { userId?: string; organizationId?: string }): number {
    let count = 0;
    const sessions = [...this.relays.values()].map((relay) => relay.session);
    for (const session of [...sessions, ...this.reserved])
      if (
        (owner.userId === undefined || session.userId === owner.userId) &&
        (owner.organizationId === undefined || session.organizationId === owner.organizationId)
      )
        count++;
    return count;
  }

  /** The session, while it waits for a side to join or runs. */
  pending(id: string): ExecSession | undefined {
    return this.relays.get(id)?.session;
  }

  /** The relay for the agent of this session's node, once; undefined otherwise. */
  joinAgent(id: string, node: { organizationId: string; nodeId: string }): ExecRelay | undefined {
    const relay = this.relays.get(id);
    if (
      !relay ||
      relay.session.organizationId !== node.organizationId ||
      relay.session.nodeId !== node.nodeId ||
      !relay.joinAgent()
    )
      return undefined;
    return relay;
  }

  /** Whether this person may still join the session: it is theirs, and no browser joined it. */
  joinable(id: string, userId: string): boolean {
    const relay = this.relays.get(id);
    return (
      relay !== undefined && relay.session.userId === userId && !relay.browserJoined && !relay.over
    );
  }

  /**
   * Ends every session, joined or still waiting for a side, with `reason`: their audit writes
   * start at once, so that `settle` waits for them.
   */
  endAll(reason: ExecEnd): void {
    for (const relay of [...this.relays.values()]) relay.end(reason, null);
  }

  /** Waits for the audit writes of the sessions that ended, at most `ms`. */
  async settle(ms: number): Promise<void> {
    await Promise.race([
      Promise.allSettled([...this.writes]),
      new Promise((resolve) => setTimeout(resolve, ms).unref()),
    ]);
  }

  /** The relay for the person who opened this session, once; undefined otherwise. */
  joinBrowser(id: string, userId: string, port: BrowserPort): ExecRelay | undefined {
    const relay = this.relays.get(id);
    if (!relay || relay.session.userId !== userId || !relay.joinBrowser(port)) return undefined;
    return relay;
  }

  private ended(relay: ExecRelay, reason: ExecEnd, exitCode: number | null, ms: number): void {
    // The connections are released at once, whatever the audit store does.
    this.relays.delete(relay.session.id);
    const event = execSessionEnded(relay.session, reason, exitCode, ms);
    const write = this.record(relay.session, event).finally(() => this.writes.delete(write));
    this.writes.add(write);
  }

  /**
   * Records a session's end, trying again while the audit store fails (issue #489). A retry first
   * looks for the event: a write whose answer was lost may have committed, and the end is
   * recorded once. Past the last attempt, the session's check records it interrupted.
   */
  private async record(session: ExecSession, event: DomainEvent): Promise<void> {
    for (let attempt = 0; attempt < CLOSE_ATTEMPTS; attempt++) {
      try {
        await this.transaction.runTenant(session.organizationId, async () => {
          if (attempt > 0 && (await this.closed(session))) return;
          await this.events.publish([event]);
        });
        return;
      } catch (error: unknown) {
        // The end comes from a connection, not a request: nothing waits to fail. Logged with
        // identifiers and the error's kind only.
        const kind = error instanceof Error ? error.name : 'unknown';
        if (attempt + 1 === CLOSE_ATTEMPTS) {
          this.logger.error(`exec session ${session.id} ended without its audit event (${kind})`);
          return;
        }
        this.logger.warn(`exec session ${session.id}: its audit event is tried again (${kind})`);
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(CLOSE_RETRY_FIRST_MS * 2 ** attempt, CLOSE_RETRY_MAX_MS),
          ).unref(),
        );
      }
    }
  }
}

export function execSessionEnded(
  session: ExecSession,
  reason: ExecEnd,
  exitCode: number | null,
  durationMs: number,
): DomainEvent {
  return createEvent({
    type: 'exec.session.ended',
    organizationId: session.organizationId,
    actor: { kind: 'user', id: session.userId },
    target: { type: 'exec_session', id: session.id },
    payload: {
      projectId: session.projectId,
      environmentId: session.environmentId,
      applicationId: session.applicationId,
      nodeId: session.nodeId,
      reason,
      exitCode,
      durationMs,
    },
  });
}

/**
 * The closing of a session whose end was never recorded: its process stopped, or its audit
 * writes kept failing. What happened in it is unknown (issue #489).
 */
export function execSessionInterrupted(session: {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
}): DomainEvent {
  return createEvent({
    type: 'exec.session.interrupted',
    organizationId: session.organizationId,
    actor: SYSTEM_ACTOR,
    target: { type: 'exec_session', id: session.id },
    payload: { userId: session.userId, reason: 'unknown' },
  });
}
