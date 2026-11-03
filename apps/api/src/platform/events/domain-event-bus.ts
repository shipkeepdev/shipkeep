import { Injectable, Logger } from '@nestjs/common';
import type { DomainEvent } from '@shipkeep/domain';

export type DomainEventHandler = (event: DomainEvent) => Promise<void>;

/**
 * In-process bus for domain events (CLAUDE.md, rule 6). Command handlers publish after their
 * state change; subscribers (the audit recorder first of all) run before `publish` resolves, so
 * a failure to record is a failure of the command and never a silent gap in the audit log.
 *
 * Asynchronous fan-out through pg-boss (ADR 0004) arrives with the first long-running reaction.
 */
@Injectable()
export class DomainEventBus {
  private readonly logger = new Logger(DomainEventBus.name);
  private readonly handlers = new Set<DomainEventHandler>();

  /** Registers a handler for every event. Returns the function that removes it. */
  subscribe(handler: DomainEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Delivers events in order to every handler. The first handler error aborts and propagates. */
  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      this.logger.debug({ type: event.type, target: event.target }, 'domain event');
      for (const handler of this.handlers) {
        await handler(event);
      }
    }
  }

  get handlerCount(): number {
    return this.handlers.size;
  }
}
