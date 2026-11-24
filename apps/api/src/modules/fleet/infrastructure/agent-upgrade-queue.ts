import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { type DomainEvent, isTenantId } from '@shipkeep/domain';
import { fromPrisma } from 'pg-boss';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { JobQueue } from '../../../platform/jobs/job-queue';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import { type AgentUpgradeWaker, UPGRADE_ACTION_KEY } from '../application/agent-upgrades';
import {
  AGENT_UPGRADE_STORE,
  type AgentUpgradeStore,
  FLEET_TRANSACTION,
  type FleetTransaction,
} from '../application/ports';

export const AGENT_UPGRADE_QUEUE = 'agent-upgrade';
const TERMINAL_ACTION = /^fleet\.action\.(succeeded|failed|cancelled|compensated|expired)$/;
/** What a server reports that can end its turn sooner than the next look. */
const NODE_REPORTS = new Set(['fleet.node.agent_version_changed', 'fleet.node.ready']);

/**
 * pg-boss queue of rollout runs (ADR 0028). `stately` keeps at most one queued and one active run
 * per rollout. A finished UpgradeAgent wakes its rollout through its key, and a server reporting a
 * version or coming back wakes the organization's running rollout.
 */
@Injectable()
export class AgentUpgradeQueue implements AgentUpgradeWaker, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentUpgradeQueue.name);
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly jobs: JobQueue,
    private readonly database: PrismaUnitOfWork,
    private readonly events: DomainEventBus,
    @Inject(AGENT_UPGRADE_STORE) private readonly upgrades: AgentUpgradeStore,
    @Inject(FLEET_TRANSACTION) private readonly transaction: FleetTransaction,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.jobs.createQueue(AGENT_UPGRADE_QUEUE, {
      policy: 'stately',
      retryLimit: 5,
      retryDelay: 10,
      retryBackoff: true,
      retryDelayMax: 300,
      expireInSeconds: 300,
      retentionSeconds: 7 * 86400,
      deleteAfterSeconds: 86400,
    });
    this.unsubscribe = this.events.subscribe((event) => this.onEvent(event));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  async wake(organizationId: string, upgradeId: string, delaySeconds = 0): Promise<void> {
    await this.jobs.send(
      AGENT_UPGRADE_QUEUE,
      { organizationId, upgradeId },
      {
        singletonKey: upgradeId,
        ...(delaySeconds > 0 ? { startAfter: delaySeconds } : {}),
        // Joins the current transaction when there is one (fixed queue name and schema).
        ...(this.database.inTransaction() ? { db: fromPrisma(this.database.client) } : {}),
      },
    );
  }

  private async onEvent(event: DomainEvent): Promise<void> {
    const organizationId = event.organizationId;
    if (!organizationId) return;
    if (TERMINAL_ACTION.test(event.type)) {
      const key = event.payload['idempotencyKey'];
      const upgradeId = typeof key === 'string' ? UPGRADE_ACTION_KEY.exec(key)?.[1] : undefined;
      if (upgradeId && isTenantId(upgradeId)) await this.wake(organizationId, upgradeId);
      return;
    }
    if (!NODE_REPORTS.has(event.type)) return;
    // Published inside the node's own transaction, under the same organization.
    await this.transaction.runTenant(organizationId, async () => {
      const running = await this.upgrades.findRunning(organizationId);
      if (!running) return;
      await this.wake(organizationId, running.id);
      this.logger.debug({ upgradeId: running.id, event: event.type }, 'agent upgrade woken');
    });
  }
}
