import type { JobQueue } from '../../../platform/jobs/job-queue';
import type { DeploymentPipeline } from '../application/deployment-pipeline';

import type { DeploymentQueue } from './deployment-queue';
import { DeploymentWorker } from './deployment-worker';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-000000000001';
const DEPLOYMENT = '0190f5a8-7b1c-7e2d-8f3a-000000000002';

function worker(run: () => Promise<'wait' | 'done'>) {
  const wake = vi.fn<DeploymentQueue['wake']>(() => Promise.resolve());
  const queue = { wake } as unknown as DeploymentQueue;
  const pipeline = { run: vi.fn(run) } as unknown as DeploymentPipeline;
  const executeSql = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>>(() =>
    Promise.resolve({ rows: [] }),
  );
  const jobs = { getDb: () => ({ executeSql }) } as unknown as JobQueue;
  return { worker: new DeploymentWorker(jobs, queue, pipeline), wake, executeSql };
}

// Issue #486: a deployment never loses its only job to an exhausted retry budget.
describe('the deployment worker', () => {
  it('runs a failed pipeline again later, longer each time, without failing the job', async () => {
    const { worker: subject, wake } = worker(() => Promise.reject(new Error('timeout')));
    await subject.handle({ organizationId: ORG, deploymentId: DEPLOYMENT });
    await subject.handle({ organizationId: ORG, deploymentId: DEPLOYMENT, failures: 1 });
    await subject.handle({ organizationId: ORG, deploymentId: DEPLOYMENT, failures: 30 });
    expect(wake.mock.calls).toEqual([
      [ORG, DEPLOYMENT, 15, 1],
      [ORG, DEPLOYMENT, 30, 2],
      [ORG, DEPLOYMENT, 300, 31],
    ]);
  });

  it('checks a waiting deployment again soon, and forgets earlier failures', async () => {
    const { worker: subject, wake } = worker(() => Promise.resolve('wait'));
    await subject.handle({ organizationId: ORG, deploymentId: DEPLOYMENT, failures: 4 });
    expect(wake.mock.calls).toEqual([[ORG, DEPLOYMENT, 15]]);
    const done = worker(() => Promise.resolve('done'));
    await done.worker.handle({ organizationId: ORG, deploymentId: DEPLOYMENT });
    expect(done.wake).not.toHaveBeenCalled();
  });

  it('ignores a job whose identifiers are not tenant ids', async () => {
    const { worker: subject, wake } = worker(() => Promise.resolve('wait'));
    await subject.handle({ organizationId: 'x', deploymentId: DEPLOYMENT });
    await subject.handle(null);
    expect(wake).not.toHaveBeenCalled();
  });

  it('wakes the deployments whose last run failed for good, and only valid ones', async () => {
    const { worker: subject, wake, executeSql } = worker(() => Promise.resolve('wait'));
    executeSql.mockResolvedValueOnce({
      rows: [
        { data: { organizationId: ORG, deploymentId: DEPLOYMENT } },
        { data: { organizationId: ORG, deploymentId: 'not-an-id' } },
      ],
    });
    expect(await subject.sweep()).toBe(1);
    expect(wake.mock.calls).toEqual([[ORG, DEPLOYMENT]]);
    expect(executeSql.mock.calls[0]?.[1]).toEqual(['deployment-run', 500]);
  });
});
