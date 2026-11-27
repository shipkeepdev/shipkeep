import { describe, expect, it } from 'vitest';

import { pushJob } from './push-worker';

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
