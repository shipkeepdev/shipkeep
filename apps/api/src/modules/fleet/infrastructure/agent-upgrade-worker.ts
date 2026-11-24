import { Injectable, Logger } from '@nestjs/common';
import { isTenantId } from '@shipkeep/domain';

import { JobQueue } from '../../../platform/jobs/job-queue';
import { AgentUpgrades } from '../application/agent-upgrades';

import { AGENT_UPGRADE_QUEUE, AgentUpgradeQueue } from './agent-upgrade-queue';

/** Runs agent rollouts from the queue; started by `main.ts` with the agent gateway. */
@Injectable()
export class AgentUpgradeWorker {
  private readonly logger = new Logger(AgentUpgradeWorker.name);

  constructor(
    private readonly jobs: JobQueue,
    private readonly queue: AgentUpgradeQueue,
    private readonly upgrades: AgentUpgrades,
  ) {}

  async start(): Promise<void> {
    await this.jobs.work<unknown>(
      AGENT_UPGRADE_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 2 },
      async (jobs) => {
        for (const job of jobs) {
          const data = job.data as Record<string, unknown> | null;
          const organizationId = data?.['organizationId'];
          const upgradeId = data?.['upgradeId'];
          if (!isTenantId(organizationId) || !isTenantId(upgradeId)) continue;
          try {
            const seconds = await this.upgrades.advance(organizationId, upgradeId);
            if (seconds !== null) await this.queue.wake(organizationId, upgradeId, seconds);
          } catch {
            // pg-boss retries the run; errors may carry driver details, never persist them.
            this.logger.warn({ upgradeId }, 'agent upgrade run failed');
            throw new Error('Agent upgrade run failed.');
          }
        }
      },
    );
  }
}
