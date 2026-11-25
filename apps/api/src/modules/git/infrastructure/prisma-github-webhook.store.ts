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
    bodySha256: Uint8Array,
    now: Date,
  ): Promise<boolean> {
    await this.database.client.githubDelivery.deleteMany({
      where: {
        organizationId,
        receivedAt: { lt: new Date(now.getTime() - DELIVERY_RETENTION_MS) },
      },
    });
    // Either key already recorded, the identifier or the body, skips the row.
    const recorded = await this.database.client.githubDelivery.createMany({
      data: {
        organizationId,
        deliveryId: delivery.delivery,
        bodySha256: new Uint8Array(bodySha256),
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
    const client = this.database.client.githubInstallation;
    const where = {
      organizationId_installationId: {
        organizationId,
        installationId: BigInt(change.installationId),
      },
    };
    const existing = await client.findUnique({ where });
    if (change.action === 'deleted') {
      if (!existing || existing.updatedAt.getTime() > change.updatedAt.getTime()) return false;
      await client.delete({ where });
      return true;
    }
    // An event no newer than the last one applied, a replay among them, changes nothing.
    if (existing && existing.updatedAt.getTime() >= change.updatedAt.getTime()) return false;
    const suspendedAt =
      change.action === 'suspend'
        ? change.updatedAt
        : change.action === 'repositories'
          ? (existing?.suspendedAt ?? null)
          : null;
    const facts = {
      accountLogin: change.accountLogin,
      accountType: change.accountType,
      repositorySelection: change.repositorySelection,
      suspendedAt,
      updatedAt: change.updatedAt,
    };
    // A change for an installation not recorded yet, its `created` delivery lost, records it.
    if (!existing)
      await client.create({
        data: {
          organizationId,
          installationId: BigInt(change.installationId),
          ...facts,
          createdAt: now,
        },
      });
    else await client.update({ where, data: facts });
    return true;
  }
}
