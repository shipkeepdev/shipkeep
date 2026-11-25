import { Module } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { IdentityModule } from '../identity/identity.module';
import { TenantAccessModule } from '../organizations/tenant-access.module';

import { GithubAppCommands } from './application/github-app-commands';
import { GIT_TRANSACTION, GITHUB_APP_STORE, GITHUB_MANIFESTS } from './application/ports';
import { GithubManifestClient } from './infrastructure/github-manifest.client';
import { PrismaGithubAppStore } from './infrastructure/prisma-github-app.store';
import { GithubAppController } from './interface/github-app.controller';

/** Git providers (ADR 0031): for now, an organization's GitHub App. */
@Module({
  imports: [IdentityModule, TenantAccessModule],
  controllers: [GithubAppController],
  providers: [
    GithubAppCommands,
    { provide: GITHUB_APP_STORE, useClass: PrismaGithubAppStore },
    { provide: GITHUB_MANIFESTS, useFactory: () => new GithubManifestClient() },
    { provide: GIT_TRANSACTION, useExisting: PrismaUnitOfWork },
  ],
})
export class GitModule {}
