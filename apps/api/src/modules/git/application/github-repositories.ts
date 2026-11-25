import { Inject, Injectable } from '@nestjs/common';

import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import { type ResourceSecurityContext as SecurityContext } from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import { type GithubRepository, MAX_LISTED_REPOSITORIES } from '../domain/github-api';

import {
  GIT_TRANSACTION,
  GITHUB_API,
  GITHUB_APP_STORE,
  type GitTransaction,
  type GithubApi,
  type GithubAppStore,
} from './ports';

/**
 * The repositories an organization's App can reach, for choosing an application's source
 * (ADR 0031). Each installation is asked with a token that reads metadata only, revoked once
 * read. Nothing changes here, so nothing is audited.
 */
@Injectable()
export class GithubRepositories {
  constructor(
    @Inject(GITHUB_APP_STORE) private readonly store: GithubAppStore,
    @Inject(GITHUB_API) private readonly github: GithubApi,
    @Inject(GIT_TRANSACTION) private readonly transaction: GitTransaction,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
  ) {}

  async list(
    context: SecurityContext,
    organizationId: string,
    now = new Date(),
  ): Promise<{ repositories: GithubRepository[]; truncated: boolean }> {
    const scope = { organizationId };
    const found = await this.accounts.run(
      context,
      async () => {
        await this.access.require(context.userId, 'organization.read', scope);
        return this.transaction.runTenant(organizationId, async () => ({
          app: await this.store.credentials(organizationId),
          installations: await this.store.activeInstallations(organizationId),
        }));
      },
      { permission: 'organization.read', target: scope },
    );
    // Without an App there is nothing to list, as `GET …/github-app` answers `{app: null}`.
    if (!found.app) return { repositories: [], truncated: false };
    // GitHub is asked outside any transaction: the answers take their time.
    const jwt = this.github.appJwt(found.app.appId, found.app.privateKey, now);
    const repositories: GithubRepository[] = [];
    let truncated = false;
    for (const installationId of found.installations) {
      const room = MAX_LISTED_REPOSITORIES - repositories.length;
      if (room <= 0) {
        truncated = true;
        break;
      }
      const { token } = await this.github.installationToken(jwt, installationId, {
        permissions: { metadata: 'read' },
      });
      try {
        const page = await this.github.repositories(token, installationId, room);
        repositories.push(...page.repositories);
        truncated ||= page.truncated;
      } finally {
        await this.github.revoke(token);
      }
    }
    repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
    return { repositories, truncated };
  }
}
