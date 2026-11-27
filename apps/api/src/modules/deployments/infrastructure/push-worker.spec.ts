import { describe, expect, it } from 'vitest';

import type { JobQueue } from '../../../platform/jobs/job-queue';
import type { PushDeployments } from '../application/push-deployments';

import { pushJob, PushWorker } from './push-worker';

const job = {
  organizationId: '0190f5a8-7b1c-7e2d-8f3a-0000000000aa',
  installationId: 31,
  repositoryId: 901,
  branch: 'main',
  commit: 'a'.repeat(40),
  pusher: 'octocat',
};

describe('the push queue job', () => {
  it('reads back what the webhook queued, with what a retry adds', () => {
    expect(pushJob(job)).toEqual(job);
    expect(pushJob({ ...job, pusher: null })).toEqual({ ...job, pusher: null });
    const retry = { ...job, only: ['0190f5a8-7b1c-7e2d-8f3a-0000000000bb'], attempt: 3 };
    expect(pushJob(retry)).toEqual(retry);
  });

  it('refuses a payload this queue never sends: it crossed the database', () => {
    for (const other of [
      { ...job, organizationId: 'acme' },
      { ...job, installationId: 0 },
      { ...job, repositoryId: '901' },
      { ...job, branch: '../main' },
      { ...job, branch: 'a..b' },
      { ...job, commit: 'main' },
      { ...job, pusher: 'not a login' },
      { ...job, only: ['not-a-uuid'] },
      { ...job, only: Array.from({ length: 21 }, () => job.organizationId) },
      { ...job, attempt: 'one' },
      null,
      'job',
    ])
      expect(pushJob(other), JSON.stringify(other)).toBeUndefined();
  });
});

describe('the push worker', () => {
  it('tries busy applications again a minute later, then gives up on them, audited', async () => {
    const busy = '0190f5a8-7b1c-7e2d-8f3a-0000000000bb';
    const sent: unknown[] = [];
    const givenUp: unknown[] = [];
    const jobs = {
      send: (_queue: string, data: unknown, options: unknown) => {
        sent.push([data, options]);
        return Promise.resolve(null);
      },
    } as unknown as JobQueue;
    const pushes = {
      handle: () => Promise.resolve([busy]),
      gaveUp: (_push: unknown, ids: unknown) => {
        givenUp.push(ids);
        return Promise.resolve();
      },
    } as unknown as PushDeployments;
    const worker = new PushWorker(jobs, pushes);
    await worker.handle({ ...job, attempt: 3 });
    expect(sent).toEqual([[{ ...job, only: [busy], attempt: 4 }, { startAfter: 60 }]]);
    expect(givenUp).toEqual([]);
    await worker.handle({ ...job, only: [busy], attempt: 29 });
    expect(sent).toHaveLength(1);
    expect(givenUp).toEqual([[busy]]);
  });
});
