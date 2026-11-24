import type { JobQueue } from '../../../platform/jobs/job-queue';
import type { AgentUpgrades } from '../application/agent-upgrades';

import type { AgentUpgradeQueue } from './agent-upgrade-queue';
import { AgentUpgradeWorker, RETRY_SECONDS } from './agent-upgrade-worker';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0123456789ab';
const UPGRADE = '0190f5a8-7b1c-7e2d-8f3a-0123456789ac';

function worker(advance: () => Promise<number | null>, wake = () => Promise.resolve()) {
  let handler: ((jobs: { data: unknown }[]) => Promise<void>) | undefined;
  const woken: unknown[][] = [];
  const jobs = {
    work: (_name: string, _options: unknown, work: typeof handler) => {
      handler = work;
      return Promise.resolve('worker');
    },
  } as unknown as JobQueue;
  const queue = {
    wake: (...args: unknown[]) => {
      woken.push(args);
      return wake();
    },
  } as unknown as AgentUpgradeQueue;
  const instance = new AgentUpgradeWorker(jobs, queue, { advance } as unknown as AgentUpgrades);
  const run = async (data: unknown) => {
    if (!handler) await instance.start();
    if (!handler) throw new Error('no handler');
    return handler([{ data }]);
  };
  return { run, woken };
}

describe('AgentUpgradeWorker', () => {
  it('queues the next run after the delay a run asks for, and none once the rollout ended', async () => {
    const waiting = worker(() => Promise.resolve(15));
    await waiting.run({ organizationId: ORG, upgradeId: UPGRADE });
    expect(waiting.woken).toEqual([[ORG, UPGRADE, 15]]);
    const ended = worker(() => Promise.resolve(null));
    await ended.run({ organizationId: ORG, upgradeId: UPGRADE });
    expect(ended.woken).toEqual([]);
  });

  it('queues a failed run again instead of leaving the rollout without one', async () => {
    const failing = worker(() => Promise.reject(new Error('connection reset by password=hunter2')));
    await failing.run({ organizationId: ORG, upgradeId: UPGRADE });
    expect(failing.woken).toEqual([[ORG, UPGRADE, RETRY_SECONDS]]);
  });

  it('leaves the run to pg-boss retries only when it cannot be queued again', async () => {
    const unreachable = worker(
      () => Promise.reject(new Error('database down')),
      () => Promise.reject(new Error('database down')),
    );
    await expect(unreachable.run({ organizationId: ORG, upgradeId: UPGRADE })).rejects.toThrow(
      'Agent upgrade run could not be queued again.',
    );
  });

  it('ignores a job whose identifiers are not tenant ids', async () => {
    const calls: string[] = [];
    const strict = worker(() => {
      calls.push('advance');
      return Promise.resolve(null);
    });
    for (const data of [
      null,
      {},
      { organizationId: ORG, upgradeId: '../x' },
      { organizationId: 1, upgradeId: UPGRADE },
    ])
      await strict.run(data);
    expect(calls).toEqual([]);
  });
});
