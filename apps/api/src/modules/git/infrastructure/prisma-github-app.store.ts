import { Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError, type Secret } from '@shipkeep/domain';

import { EnvelopeService } from '../../../platform/crypto/envelope.service';
import { Prisma } from '../../../platform/prisma/generated/client';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { GithubAppFlow, GithubAppStore } from '../application/ports';
import type { CreatedGithubApp, GithubAppMetadata } from '../domain/github-app';

/**
 * The App's secrets are encrypted with the organization's data key and bound to the App's
 * identifier and to what each one is, so a value moved to another column, App or organization
 * cannot be decrypted there (SPEC 9).
 */
@Injectable()
export class PrismaGithubAppStore implements GithubAppStore {
  constructor(
    private readonly database: PrismaUnitOfWork,
    private readonly envelope: EnvelopeService,
  ) {}

  async organizationSlug(organizationId: string): Promise<string> {
    const organization = await this.database.client.organization.findUnique({
      where: { id: organizationId },
      select: { slug: true },
    });
    if (!organization) throw new NotFoundError('organization');
    return organization.slug;
  }

  async find(organizationId: string): Promise<GithubAppMetadata | undefined> {
    const row = await this.database.client.githubApp.findUnique({
      where: { organizationId },
      select: { appId: true, slug: true, name: true, ownerLogin: true, createdAt: true },
    });
    return row ? { ...row, appId: Number(row.appId) } : undefined;
  }

  async startFlow(organizationId: string, flow: GithubAppFlow): Promise<void> {
    const data = {
      stateHash: new Uint8Array(flow.stateHash),
      userId: flow.userId,
      expiresAt: flow.expiresAt,
    };
    await this.database.client.githubAppFlow.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
    });
  }

  async flow(organizationId: string): Promise<GithubAppFlow | undefined> {
    const row = await this.database.client.githubAppFlow.findUnique({ where: { organizationId } });
    return row
      ? { stateHash: new Uint8Array(row.stateHash), userId: row.userId, expiresAt: row.expiresAt }
      : undefined;
  }

  async create(
    organizationId: string,
    stateHash: Uint8Array,
    app: CreatedGithubApp,
    createdBy: string,
    now: Date,
  ): Promise<GithubAppMetadata | undefined> {
    // The flow ends with its App: a second completion of the same flow finds nothing to end.
    const ended = await this.database.client.githubAppFlow.deleteMany({
      where: { organizationId, stateHash: new Uint8Array(stateHash) },
    });
    if (ended.count !== 1) return undefined;
    const [privateKeyEnc, webhookSecretEnc, clientSecretEnc] = await Promise.all([
      this.encrypt(organizationId, app.appId, 'private-key', app.privateKey),
      this.encrypt(organizationId, app.appId, 'webhook-secret', app.webhookSecret),
      this.encrypt(organizationId, app.appId, 'client-secret', app.clientSecret),
    ]);
    try {
      await this.database.client.githubApp.create({
        data: {
          organizationId,
          appId: BigInt(app.appId),
          slug: app.slug,
          name: app.name,
          ownerLogin: app.ownerLogin,
          clientId: app.clientId,
          privateKeyEnc,
          webhookSecretEnc,
          clientSecretEnc,
          createdBy,
          createdAt: now,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictError('github_app_exists', 'This organization already has a GitHub App.');
      throw error;
    }
    return {
      appId: app.appId,
      slug: app.slug,
      name: app.name,
      ownerLogin: app.ownerLogin,
      createdAt: now,
    };
  }

  private async encrypt(
    organizationId: string,
    appId: number,
    what: 'private-key' | 'webhook-secret' | 'client-secret',
    value: Secret,
  ): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(
      await this.envelope.encryptFor(
        `organization:${organizationId}`,
        `github-app:${String(appId)}:${what}`,
        Buffer.from(value.expose(), 'utf8'),
      ),
    );
  }
}
