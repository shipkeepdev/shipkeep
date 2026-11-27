import { Module } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { IdentityModule } from '../identity/identity.module';
import { REPOSITORY_SOURCE } from '../apps/application/ports';
import { TenantAccessModule } from '../organizations/tenant-access.module';

import { GithubAppCommands } from './application/github-app-commands';
import { GithubRepositories } from './application/github-repositories';
import { GithubSources } from './application/github-sources';
import { GithubWebhooks } from './application/github-webhooks';
import {
  GIT_TRANSACTION,
  GITHUB_API,
  GITHUB_APP_STORE,
  GITHUB_MANIFESTS,
  GITHUB_WEBHOOK_STORE,
} from './application/ports';
import { GithubApiClient } from './infrastructure/github-api.client';
import { GithubManifestClient } from './infrastructure/github-manifest.client';
import { PrismaGithubAppStore } from './infrastructure/prisma-github-app.store';
import { PrismaGithubWebhookStore } from './infrastructure/prisma-github-webhook.store';
import { GithubAppController } from './interface/github-app.controller';
import { GithubWebhookController } from './interface/github-webhook.controller';

/**
 * Git providers (ADR 0031): for now, an organization's GitHub App, its webhooks, and the reading of
 * a Git application's configuration from its repository.
 */
@Module({
  imports: [IdentityModule, TenantAccessModule],
  controllers: [GithubAppController, GithubWebhookController],
  providers: [
    GithubAppCommands,
    GithubRepositories,
    GithubSources,
    { provide: REPOSITORY_SOURCE, useExisting: GithubSources },
    { provide: GITHUB_API, useFactory: () => new GithubApiClient() },
    GithubWebhooks,
    { provide: GITHUB_WEBHOOK_STORE, useClass: PrismaGithubWebhookStore },
    { provide: GITHUB_APP_STORE, useClass: PrismaGithubAppStore },
    { provide: GITHUB_MANIFESTS, useFactory: () => new GithubManifestClient() },
    { provide: GIT_TRANSACTION, useExisting: PrismaUnitOfWork },
  ],
  // Applications read their configuration from their repository through it.
  exports: [REPOSITORY_SOURCE],
})
export class GitModule {}
