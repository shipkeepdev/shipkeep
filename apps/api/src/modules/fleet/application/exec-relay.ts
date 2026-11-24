import { Inject, Injectable, Logger } from '@nestjs/common';
import { createEvent, type DomainEvent } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';

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

/** The browser's connection, as the relay sees it. `send` resolves once the frame is written. */
export interface BrowserPort {
  send(frame: AgentFrame): Promise<void>;
  close(): void;
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
  | 'signed_out';

/** The agent's fixed error texts (agent/internal/actions/exec.go), and what they mean. */
const AGENT_ERRORS: Readonly<Partial<Record<string, ExecEnd>>> = {
  'time limit reached': 'time_limit',
  'session closed': 'closed',
  'session failed': 'failed',
};

/** The end an agent's error frame says, from its fixed texts; any other text is a failure. */
export function execEndOf(message: string): ExecEnd {
  return AGENT_ERRORS[message] ?? 'failed';
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
  private startedAt: number | undefined;
  private readonly waiting: BrowserFrame[] = [];
  private wake: (() => void) | undefined;
  private settle: ((both: boolean) => void) | undefined;
  private readonly joined: Promise<boolean>;
  private readonly timer: ReturnType<typeof setTimeout>;

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
    await this.browser.send(frame);
    if (frame.kind === 'exit') this.end('exited', frame.code);
    else if (frame.kind === 'error') this.end(execEndOf(frame.message), null);
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

  /** Whether the session ended. */
  get over(): boolean {
    return this.ended !== undefined;
  }

  /** Ends the session once: both sides are released and the end is recorded. */
  end(reason: ExecEnd, exitCode: number | null): void {
    if (this.ended) return;
    this.ended = reason;
    clearTimeout(this.timer);
    this.settle?.(false);
    this.wake?.();
    this.browser?.close();
    const started = this.startedAt;
    this.onEnd(this, reason, exitCode, started === undefined ? 0 : Date.now() - started);
  }

  private start(): void {
    if (!this.browser || !this.agentJoined) return;
    this.startedAt = Date.now();
    this.settle?.(true);
  }
}

/**
 * Sessions opened on this API process. A session lives only as long as both its connections,
 * which both reach this process, so it is never stored: a restart ends it, and the agent's
 * action ends with its stream. Each end is audited as `exec.session.ended`.
 */
@Injectable()
export class ExecSessionRegistry {
  private readonly logger = new Logger(ExecSessionRegistry.name);
  private readonly relays = new Map<string, ExecRelay>();

  constructor(
    @Inject(FLEET_TRANSACTION) private readonly transaction: FleetTransaction,
    private readonly events: DomainEventBus,
  ) {}

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

  /** The relay for the person who opened this session, once; undefined otherwise. */
  joinBrowser(id: string, userId: string, port: BrowserPort): ExecRelay | undefined {
    const relay = this.relays.get(id);
    if (!relay || relay.session.userId !== userId || !relay.joinBrowser(port)) return undefined;
    return relay;
  }

  private ended(relay: ExecRelay, reason: ExecEnd, exitCode: number | null, ms: number): void {
    this.relays.delete(relay.session.id);
    const event = execSessionEnded(relay.session, reason, exitCode, ms);
    // The end comes from a connection, not a request: nothing waits to fail, so a failed write
    // is logged, with identifiers only.
    this.transaction
      .runTenant(relay.session.organizationId, () => this.events.publish([event]))
      .catch(() => {
        this.logger.error(`exec session ${relay.session.id} ended without its audit event`);
      });
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
