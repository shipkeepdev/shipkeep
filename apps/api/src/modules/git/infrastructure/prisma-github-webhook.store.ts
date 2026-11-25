import { Injectable } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';

import { ValueDecryptionError } from '../../../platform/crypto/envelope';
import { EnvelopeService } from '../../../platform/crypto/envelope.service';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { GithubWebhookStore } from '../application/ports';
import {
  DELIVERY_RETENTION_MS,
  type DeliveryHeaders,
  type InstallationChange,
  WebhookRejected,
} from '../domain/github-webhook';

@Injectable()
export class PrismaGithubWebhookStore implements GithubWebhookStore {
  constructor(
    private readonly database: PrismaUnitOfWork,
    private readonly envelope: EnvelopeService,
  ) {}

  async webhookSecret(
    organizationId: string,
  ): Promise<{ appId: number; secret: Secret } | undefined> {
    const row = await this.database.client.githubApp.findUnique({
      where: { organizationId },
      select: { appId: true, webhookSecretEnc: true },
    });
    if (!row) return undefined;
    try {
      const secret = await this.envelope.decryptFor(
        `organization:${organizationId}`,
        `github-app:${String(row.appId)}:webhook-secret`,
        Buffer.from(row.webhookSecretEnc),
      );
      return { appId: Number(row.appId), secret: new Secret(secret.toString('utf8')) };
    } catch (error: unknown) {
      // A secret that no longer decrypts (a row moved or altered) authenticates nothing. A data
      // key that cannot be read reaches the caller as it is, and GitHub delivers again later.
      if (error instanceof ValueDecryptionError) throw new WebhookRejected();
      throw error;
    }
  }

  async recordDelivery(
    organizationId: string,
    delivery: DeliveryHeaders,
    now: Date,
  ): Promise<boolean> {
    await this.database.client.githubDelivery.deleteMany({
      where: {
        organizationId,
        receivedAt: { lt: new Date(now.getTime() - DELIVERY_RETENTION_MS) },
      },
    });
    const recorded = await this.database.client.githubDelivery.createMany({
      data: {
        deliveryId: delivery.delivery,
        organizationId,
        event: delivery.event,
        receivedAt: now,
      },
      skipDuplicates: true,
    });
    return recorded.count === 1;
  }

  async applyInstallation(
    organizationId: string,
    change: InstallationChange,
    now: Date,
  ): Promise<boolean> {
    const installationId = BigInt(change.installationId);
    const client = this.database.client.githubInstallation;
    if (change.action === 'deleted') {
      const removed = await client.deleteMany({ where: { organizationId, installationId } });
      return removed.count === 1;
    }
    const facts = {
      accountLogin: change.accountLogin,
      accountType: change.accountType,
      repositorySelection: change.repositorySelection,
      updatedAt: now,
    };
    if (change.action === 'created') {
      const added = await client.createMany({
        data: { installationId, organizationId, ...facts, suspendedAt: null, createdAt: now },
        skipDuplicates: true,
      });
      return added.count === 1;
    }
    const updated = await client.updateMany({
      where: {
        organizationId,
        installationId,
        suspendedAt: change.action === 'suspend' ? null : { not: null },
      },
      data: { ...facts, suspendedAt: change.action === 'suspend' ? now : null },
    });
    return updated.count === 1;
  }
}
