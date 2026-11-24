import { Injectable } from '@nestjs/common';

/** A session waiting for the browser and the agent to join it, then relayed between them. */
export interface ExecSession {
  readonly id: string;
  readonly organizationId: string;
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

/**
 * Sessions opened on this API process. A session lives only as long as both its connections,
 * which both reach this process, so it is never stored: a restart ends it, and the agent's
 * action ends with its stream.
 */
@Injectable()
export class ExecSessionRegistry {
  private readonly sessions = new Map<string, ExecSession>();

  add(session: ExecSession, now = new Date()): void {
    this.prune(now);
    this.sessions.set(session.id, session);
  }

  /** Sessions of this person or organization still waiting to be joined. */
  count(owner: { userId?: string; organizationId?: string }, now = new Date()): number {
    this.prune(now);
    let count = 0;
    for (const session of this.sessions.values())
      if (
        (owner.userId === undefined || session.userId === owner.userId) &&
        (owner.organizationId === undefined || session.organizationId === owner.organizationId)
      )
        count++;
    return count;
  }

  /** The session, while it may still be joined. */
  pending(id: string, now = new Date()): ExecSession | undefined {
    this.prune(now);
    return this.sessions.get(id);
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  private prune(now: Date): void {
    for (const [id, session] of this.sessions)
      if (session.attachBy.getTime() <= now.getTime()) this.sessions.delete(id);
  }
}
