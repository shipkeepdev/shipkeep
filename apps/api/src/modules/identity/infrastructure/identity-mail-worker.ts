import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';
import { z } from 'zod';

import { EnvelopeService } from '../../../platform/crypto/envelope.service';
import { JobQueue } from '../../../platform/jobs/job-queue';
import { normalizeEmail, TOKEN_PATTERN } from '../domain/identity-policy';

import {
  IDENTITY_DELIVERY,
  type IdentityDelivery,
  IDENTITY_MAIL_QUEUE,
  PrivateIdentityMail,
} from './private-identity-mail';

const jobSchema = z.object({ id: z.uuid(), ciphertext: z.string().min(1).max(8192) }).strict();
const messageSchema = z
  .object({
    email: z.string().max(254),
    purpose: z.enum(['verify', 'reset']),
    token: z.string().regex(TOKEN_PATTERN),
    expiresAt: z.iso.datetime(),
  })
  .strict();

@Injectable()
export class IdentityMailWorker implements OnModuleInit {
  constructor(
    private readonly jobs: JobQueue,
    private readonly mail: PrivateIdentityMail,
    private readonly envelope: EnvelopeService,
    @Inject(IDENTITY_DELIVERY) private readonly delivery: IdentityDelivery,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.mail.initialize();
    await this.jobs.work<unknown>(
      IDENTITY_MAIL_QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) {
          try {
            const data = jobSchema.parse(job.data);
            if (data.id !== job.id) throw new Error('invalid message binding');
            const plaintext = await this.envelope.decryptFor(
              'identity:mail',
              `message:${data.id}`,
              Buffer.from(data.ciphertext, 'base64'),
            );
            try {
              const input = messageSchema.parse(JSON.parse(plaintext.toString('utf8')) as unknown);
              const expiresAt = new Date(input.expiresAt);
              if (expiresAt.getTime() <= Date.now()) continue;
              await this.delivery.deliver({
                email: normalizeEmail(input.email),
                purpose: input.purpose,
                token: new Secret(input.token),
                expiresAt,
              });
            } finally {
              plaintext.fill(0);
            }
          } catch {
            // pg-boss stores worker errors; never persist SMTP responses or validation details.
            throw new Error('Identity email delivery failed.');
          }
        }
      },
    );
  }
}
