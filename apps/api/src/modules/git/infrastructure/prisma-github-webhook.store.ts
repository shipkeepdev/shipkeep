import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';

import { ValueDecryptionError } from '../../../platform/crypto/envelope';
import { EnvelopeService } from '../../../platform/crypto/envelope.service';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { GithubWebhookStore } from '../application/ports';
import {
  changeApplies,
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
    // One installation's deliveries apply one at a time, its first one included: two at once
    // would both find the same row, and the older could write last.
    await this.database.client
      .$queryRaw`SELECT pg_advisory_xact_lock(${installationLockKey(organizationId, change.installationId)})::text`;
    const client = this.database.client.githubInstallation;
    const where = {
      organizationId_installationId: {
        organizationId,
        installationId: BigInt(change.installationId),
      },
    };
    const existing = await client.findUnique({ where });
    if (!changeApplies(change, existing)) return false;
    if (change.action === 'deleted') {
      // The tombstone outlives the delivery records: nothing brings the installation back.
      if (existing)
        await client.update({
          where,
          data: {
            deletedAt: now,
            updatedAt: new Date(Math.max(existing.updatedAt.getTime(), change.updatedAt.getTime())),
          },
        });
      else
        await client.create({
          data: {
            organizationId,
            installationId: BigInt(change.installationId),
            accountLogin: change.accountLogin,
            accountType: change.accountType,
            repositorySelection: change.repositorySelection,
            suspendedAt: null,
            createdAt: now,
            updatedAt: change.updatedAt,
            deletedAt: now,
          },
        });
      return true;
    }
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

/** The lock that applies one installation's deliveries one at a time. */
export function installationLockKey(organizationId: string, installationId: number): bigint {
  const hash = createHash('sha256')
    .update(`shipkeep:github-installation:${organizationId}:${String(installationId)}`)
    .digest('hex');
  return BigInt.asIntN(64, BigInt(`0x${hash.slice(0, 16)}`));
}
