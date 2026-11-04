import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { fromPrisma } from 'pg-boss';
import { v7 as uuidv7 } from 'uuid';

import { EnvelopeService } from '../../../platform/crypto/envelope.service';
import { JobQueue } from '../../../platform/jobs/job-queue';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { IdentityMailer } from '../application/identity-ports';

export const IDENTITY_MAIL_QUEUE = 'identity-mail';
export const IDENTITY_DELIVERY = Symbol('IdentityDelivery');
export interface IdentityDelivery {
  deliver(input: Parameters<IdentityMailer['send']>[0]): Promise<void>;
}

/** The database contains ciphertext, including for failed/retried jobs. */
@Injectable()
export class PrivateIdentityMail implements IdentityMailer {
  private initialized: Promise<void> | undefined;

  constructor(
    private readonly jobs: JobQueue,
    private readonly database: PrismaUnitOfWork,
    private readonly envelope: EnvelopeService,
  ) {}

  initialize(): Promise<void> {
    this.initialized ??= this.jobs
      .createQueue(IDENTITY_MAIL_QUEUE, {
        retryLimit: 5,
        retryDelay: 15,
        retryBackoff: true,
        retryDelayMax: 120,
        expireInSeconds: 60,
        retentionSeconds: 86400,
        deleteAfterSeconds: 3600,
      })
      .catch(() => {
        this.initialized = undefined;
        throw new ServiceUnavailableException('Email delivery temporarily unavailable.');
      });
    return this.initialized;
  }

  async send(input: Parameters<IdentityMailer['send']>[0]): Promise<void> {
    await this.initialize();
    const id = uuidv7();
    const plaintext = Buffer.from(
      JSON.stringify({
        email: input.email,
        purpose: input.purpose,
        token: input.token.expose(),
        expiresAt: input.expiresAt.toISOString(),
      }),
    );
    try {
      const ciphertext = await this.envelope.encryptFor(
        'identity:mail',
        `message:${id}`,
        plaintext,
      );
      // The upstream Prisma adapter binds pg-boss values as SQL parameters and joins the
      // current transaction. Queue name and schema are fixed, never request-controlled.
      const jobId = await this.jobs.send(
        IDENTITY_MAIL_QUEUE,
        { id, ciphertext: ciphertext.toString('base64') },
        { id, db: fromPrisma(this.database.client) },
      );
      if (!jobId) throw new Error('mail job was not created');
    } catch {
      throw new ServiceUnavailableException('Email delivery temporarily unavailable.');
    } finally {
      plaintext.fill(0);
    }
  }
}
