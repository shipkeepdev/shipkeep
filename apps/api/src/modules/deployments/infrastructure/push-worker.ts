import { Injectable, Logger } from '@nestjs/common';
import { isTenantId } from '@shipkeep/domain';

import { JobQueue } from '../../../platform/jobs/job-queue';
import { validBranch } from '../../git/domain/github-api';
import { GITHUB_PUSH_QUEUE, type PushEvent } from '../../git/domain/github-webhook';
import { PushDeployments } from '../application/push-deployments';

/** A push whose applications are busy is tried again after this long, this many times at most. */
const AGAIN_SECONDS = 60;
const MAX_ATTEMPTS = 30;
const COMMIT = /^[0-9a-f]{40}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/**
 * The queue's job: a push, with the page of its applications it handles. The first job takes the
 * first page; the next page of a full one is sent at once (`after`); applications left to try
 * again are sent a minute later with the attempt (`only`).
 */
interface PushJob extends PushEvent {
  readonly only?: readonly string[];
  readonly after?: string;
  readonly attempt?: number;
}

/**
 * Works the queue of verified pushes (ADR 0031); started by `main.ts` with the deployment worker.
 * A job's payload is checked again here: it crossed the database.
 */
@Injectable()
export class PushWorker {
  private readonly logger = new Logger(PushWorker.name);

  constructor(
    private readonly jobs: JobQueue,
    private readonly pushes: PushDeployments,
  ) {}

  async start(): Promise<void> {
    await this.jobs.work<unknown>(
      GITHUB_PUSH_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 2 },
      async (jobs) => {
        for (const job of jobs) await this.handle(job.data);
      },
    );
  }

  async handle(data: unknown): Promise<void> {
    const job = pushJob(data);
    if (!job) return;
    const { only, after, attempt: tried, ...push } = job;
    const { again, next } = await this.pushes.handle(
      push,
      only ? { only } : after ? { after } : {},
    );
    if (next) await this.jobs.send(GITHUB_PUSH_QUEUE, { ...push, after: next } satisfies PushJob);
    const attempt = (tried ?? 0) + 1;
    if (again.length === 0) return;
    if (attempt >= MAX_ATTEMPTS) {
      this.logger.warn({ commit: job.commit, applications: again.length }, 'push given up');
      await this.pushes.gaveUp(push, again);
      return;
    }
    const retry: PushJob = { ...push, only: again, attempt };
    await this.jobs.send(GITHUB_PUSH_QUEUE, retry, { startAfter: AGAIN_SECONDS });
  }
}

/** The job's payload, or undefined when it is not one this queue sends. */
export function pushJob(data: unknown): PushJob | undefined {
  const value =
    typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
  if (!value) return undefined;
  const {
    organizationId,
    installationId,
    repositoryId,
    branch,
    commit,
    pusher,
    only,
    after,
    attempt,
  } = value;
  const id = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  if (
    !isTenantId(organizationId) ||
    !id(installationId) ||
    !id(repositoryId) ||
    typeof branch !== 'string' ||
    !validBranch(branch) ||
    typeof commit !== 'string' ||
    !COMMIT.test(commit) ||
    !(pusher === null || (typeof pusher === 'string' && LOGIN.test(pusher))) ||
    !(
      only === undefined ||
      (Array.isArray(only) && only.length <= 20 && only.every((entry) => isTenantId(entry)))
    ) ||
    !(after === undefined || (isTenantId(after) && only === undefined)) ||
    !(attempt === undefined || (typeof attempt === 'number' && Number.isSafeInteger(attempt)))
  )
    return undefined;
  return {
    organizationId,
    installationId,
    repositoryId,
    branch,
    commit,
    pusher,
    ...(only === undefined ? {} : { only }),
    ...(after === undefined ? {} : { after }),
    ...(attempt === undefined ? {} : { attempt }),
  };
}
