import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { auditRecordFromEvent } from '../domain/audit-record';

import { AUDIT_EVENT_STORE, type AuditEventStore } from './audit-event-store';

/**
 * Appends one audit record per domain event (CLAUDE.md, rule 6). Subscribed for the lifetime
 * of the application; a store failure propagates to the publishing command.
 */
@Injectable()
export class AuditRecorder implements OnModuleInit, OnModuleDestroy {
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly bus: DomainEventBus,
    @Inject(AUDIT_EVENT_STORE) private readonly store: AuditEventStore,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe((event) => this.record(event));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  async record(event: DomainEvent): Promise<void> {
    await this.store.append(auditRecordFromEvent(event, uuidv7()));
  }
}
