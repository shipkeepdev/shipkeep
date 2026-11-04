import { AppConfig } from '../../platform/config/app-config';
import { EnvelopeService } from '../../platform/crypto/envelope.service';
import { JobQueue } from '../../platform/jobs/job-queue';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

import type { IdentityMailer } from './application/identity-ports';
import { IdentityMailWorker } from './infrastructure/identity-mail-worker';
import { issueToken } from './infrastructure/identity-secrets';
import { IDENTITY_MAIL_QUEUE, PrivateIdentityMail } from './infrastructure/private-identity-mail';

describe('private identity email jobs against PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let jobs: JobQueue;
  let closeJobs: (() => Promise<void>) | undefined;
  let mail: PrivateIdentityMail;
  let database: PrismaUnitOfWork;
  let envelope: EnvelopeService;
  const message: Parameters<IdentityMailer['send']>[0] = {
    email: 'person@example.com',
    purpose: 'verify',
    token: issueToken(),
    expiresAt: new Date(Date.now() + 3600000),
  };

  beforeAll(async () => {
    fixture = await integrationApp();
    close = fixture.close;
    database = fixture.app.get(PrismaUnitOfWork);
    envelope = fixture.app.get(EnvelopeService);
    jobs = new JobQueue(fixture.app.get(AppConfig));
    closeJobs = () => jobs.onModuleDestroy();
    await jobs.onModuleInit();
    mail = new PrivateIdentityMail(jobs, database, envelope);
    await mail.initialize();
  });
  afterAll(async () => {
    try {
      await closeJobs?.();
    } finally {
      await close?.();
    }
  });
  beforeEach(async () => {
    await jobs.deleteAllJobs(IDENTITY_MAIL_QUEUE);
  });
  afterEach(async () => {
    await jobs.offWork(IDENTITY_MAIL_QUEUE);
  });

  it('stores only ciphertext and keeps delivery atomic with command rollback', async () => {
    await expect(
      database.run(async () => {
        await mail.send(message);
        throw new Error('injected rollback');
      }),
    ).rejects.toThrow('injected rollback');
    expect(await jobs.findJobs(IDENTITY_MAIL_QUEUE)).toHaveLength(0);
    await database.run(() => mail.send(message));
    const stored = await jobs.findJobs(IDENTITY_MAIL_QUEUE);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(message.email);
    expect(JSON.stringify(stored)).not.toContain(message.token.expose());
  });

  it('delivers a committed job after a queue restart', async () => {
    await mail.send(message);
    await jobs.onModuleDestroy();
    jobs = new JobQueue(fixture.app.get(AppConfig));
    await jobs.onModuleInit();
    mail = new PrivateIdentityMail(jobs, database, envelope);
    const received: Parameters<IdentityMailer['send']>[0][] = [];
    const worker = new IdentityMailWorker(jobs, mail, envelope, {
      deliver: (input) => {
        received.push(input);
        return Promise.resolve();
      },
    });
    await worker.start();
    await vi.waitFor(
      () => {
        expect(received).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    expect(received[0]?.token.expose()).toBe(message.token.expose());
    await vi.waitFor(
      async () => {
        expect((await jobs.findJobs(IDENTITY_MAIL_QUEUE))[0]?.state).toBe('completed');
      },
      { timeout: 5000 },
    );
  });

  it('retries failed delivery without storing a transport error or its credentials', async () => {
    await mail.initialize();
    await jobs.updateQueue(IDENTITY_MAIL_QUEUE, { retryDelay: 0, retryBackoff: false });
    const failure = `SMTP rejected ${message.token.expose()}`;
    const deliver = vi.fn().mockRejectedValueOnce(new Error(failure)).mockResolvedValue(undefined);
    const worker = new IdentityMailWorker(jobs, mail, envelope, { deliver });
    await mail.send(message);
    await worker.start();
    await vi.waitFor(
      () => {
        expect(deliver).toHaveBeenCalledTimes(2);
      },
      { timeout: 8000 },
    );
    await vi.waitFor(
      async () => {
        expect((await jobs.findJobs(IDENTITY_MAIL_QUEUE))[0]?.state).toBe('completed');
      },
      { timeout: 5000 },
    );
    const dump = JSON.stringify(
      await fixture.app.get(PrismaService).$queryRaw`SELECT * FROM shipkeep_jobs.job`,
    );
    expect(dump).not.toContain(message.token.expose());
    expect(dump).not.toContain('SMTP rejected');
  });

  it('does not send expired credentials and rejects tampered ciphertext', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    await jobs.updateQueue(IDENTITY_MAIL_QUEUE, { retryLimit: 0 });
    await mail.send({ ...message, expiresAt: new Date(0) });
    const fakeId = '0192f0c0-0000-7000-8000-0000000000aa';
    await jobs.send(IDENTITY_MAIL_QUEUE, { id: fakeId, ciphertext: 'corrupted' }, { id: fakeId });
    await new IdentityMailWorker(jobs, mail, envelope, { deliver }).start();
    await vi.waitFor(
      async () => {
        const states = (await jobs.findJobs(IDENTITY_MAIL_QUEUE)).map((job) => job.state);
        expect(states.sort()).toEqual(['completed', 'failed']);
      },
      { timeout: 8000 },
    );
    expect(deliver).not.toHaveBeenCalled();
  });
});
