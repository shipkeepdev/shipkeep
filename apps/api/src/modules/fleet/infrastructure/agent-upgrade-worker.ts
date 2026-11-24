import { Injectable, Logger } from '@nestjs/common';
import { isTenantId } from '@shipkeep/domain';

import { JobQueue } from '../../../platform/jobs/job-queue';
import { AgentUpgrades } from '../application/agent-upgrades';

import { AGENT_UPGRADE_QUEUE, AgentUpgradeQueue } from './agent-upgrade-queue';

/** A run that failed runs again after this long. */
export const RETRY_SECONDS = 60;

/**
 * Runs agent rollouts from the queue; started by `main.ts` with the agent gateway. A running
 * rollout always keeps a queued run: a failed run is queued again, and the overview, a finished
 * action and a server coming back queue one too.
 */
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
          let seconds: number | null;
          try {
            seconds = await this.upgrades.advance(organizationId, upgradeId);
          } catch {
            // The run failed (a database or GitHub error, a concurrent run): it is queued again
            // rather than left to pg-boss's retries, which end, so a running rollout always keeps
            // a run. Errors may carry driver details: they are never logged or persisted.
            this.logger.warn({ upgradeId }, 'agent upgrade run failed; it runs again later');
            seconds = RETRY_SECONDS;
          }
          if (seconds === null) continue;
          try {
            await this.queue.wake(organizationId, upgradeId, seconds);
          } catch {
            // Without a queued run, pg-boss retries this one (the database is unreachable).
            throw new Error('Agent upgrade run could not be queued again.');
          }
        }
      },
    );
  }
}
