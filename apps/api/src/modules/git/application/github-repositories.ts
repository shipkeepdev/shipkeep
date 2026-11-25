import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';

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

/** How long an organization's list is reused: each listing costs GitHub several calls. */
const CACHE_MS = 60_000;

/** The repositories an organization's App reaches, and what the listing could not reach. */
export interface RepositoryListing {
  readonly repositories: GithubRepository[];
  /** True when the listing stopped at its bound with pages or installations left. */
  readonly truncated: boolean;
  /** Installations GitHub did not answer for, removed or suspended there meanwhile. */
  readonly unreachable: number[];
}

/**
 * The repositories an organization's App can reach, for choosing an application's source
 * (ADR 0031). Each installation is asked with a token that reads metadata only, revoked once
 * read; an installation GitHub does not answer for is reported, not fatal, unless none answers.
 * A listing is reused for a minute while the installations stay the same. Nothing changes here,
 * so nothing is audited.
 */
@Injectable()
export class GithubRepositories {
  private readonly cache = new Map<string, { at: number; listing: RepositoryListing }>();

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
  ): Promise<RepositoryListing> {
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
    if (!found.app) return { repositories: [], truncated: false, unreachable: [] };
    // An installation added or removed since is a new listing.
    const key = `${organizationId}:${found.installations.join(',')}`;
    const cached = this.cache.get(key);
    if (cached && now.getTime() - cached.at < CACHE_MS) return cached.listing;
    const app = found.app;
    // GitHub is asked outside any transaction: the answers take their time.
    const repositories: GithubRepository[] = [];
    const unreachable: number[] = [];
    let truncated = false;
    for (const [index, installationId] of found.installations.entries()) {
      const room = MAX_LISTED_REPOSITORIES - repositories.length;
      if (room <= 0) {
        truncated = index < found.installations.length;
        break;
      }
      try {
        // A JWT for each installation: it lasts nine minutes, a long listing may not.
        const jwt = this.github.appJwt(app.appId, app.privateKey, new Date());
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
      } catch (error: unknown) {
        // An installation removed on GitHub whose delivery was lost must not hide the others.
        if (!(error instanceof ServiceUnavailableException)) throw error;
        unreachable.push(installationId);
      }
    }
    if (found.installations.length > 0 && unreachable.length === found.installations.length)
      throw new ServiceUnavailableException('GitHub could not be reached. Try again in a moment.');
    repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
    const listing = { repositories, truncated, unreachable };
    for (const [stale, entry] of this.cache)
      if (now.getTime() - entry.at >= CACHE_MS) this.cache.delete(stale);
    this.cache.set(key, { at: now.getTime(), listing });
    return listing;
  }
}
