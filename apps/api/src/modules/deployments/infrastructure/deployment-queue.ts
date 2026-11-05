import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type DomainEvent, isTenantId } from '@shipkeep/domain';
import { fromPrisma } from 'pg-boss';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { JobQueue } from '../../../platform/jobs/job-queue';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { DeploymentWaker } from '../application/ports';

export const DEPLOYMENT_QUEUE = 'deployment-run';
const TERMINAL_ACTION = /^fleet\.action\.(succeeded|failed|cancelled|compensated|expired)$/;
const PIPELINE_KEY = /^d:([0-9a-f-]{36}):/;

/** Job payload: identifiers only, never configuration or secrets. */
export interface DeploymentJob {
  readonly organizationId: string;
  readonly deploymentId: string;
}

/**
 * pg-boss queue of pipeline runs (ADR 0004). `stately` keeps at most one queued and one active
 * run per deployment. Runs are sent in the caller's transaction, so a deployment and its first
 * run commit together, and a finished agent action wakes the deployment that owns its key.
 */
@Injectable()
export class DeploymentQueue implements DeploymentWaker, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeploymentQueue.name);
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly jobs: JobQueue,
    private readonly database: PrismaUnitOfWork,
    private readonly events: DomainEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.jobs.createQueue(DEPLOYMENT_QUEUE, {
      policy: 'stately',
      retryLimit: 5,
      retryDelay: 10,
      retryBackoff: true,
      retryDelayMax: 300,
      expireInSeconds: 600,
      retentionSeconds: 7 * 86400,
      deleteAfterSeconds: 86400,
    });
    this.unsubscribe = this.events.subscribe((event) => this.onEvent(event));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  async wake(organizationId: string, deploymentId: string, delaySeconds = 0): Promise<void> {
    const job: DeploymentJob = { organizationId, deploymentId };
    await this.jobs.send(DEPLOYMENT_QUEUE, job, {
      singletonKey: deploymentId,
      ...(delaySeconds > 0 ? { startAfter: delaySeconds } : {}),
      // Joins the current transaction when there is one (fixed queue name and schema).
      ...(this.database.inTransaction() ? { db: fromPrisma(this.database.client) } : {}),
    });
  }

  private async onEvent(event: DomainEvent): Promise<void> {
    if (!TERMINAL_ACTION.test(event.type) || !event.organizationId) return;
    const key = event.payload['idempotencyKey'];
    const deploymentId = typeof key === 'string' ? PIPELINE_KEY.exec(key)?.[1] : undefined;
    if (!deploymentId || !isTenantId(deploymentId)) return;
    await this.wake(event.organizationId, deploymentId);
    this.logger.debug({ deploymentId }, 'deployment woken by an agent action');
  }
}
