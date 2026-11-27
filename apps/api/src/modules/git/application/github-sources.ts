import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, InvalidInputError } from '@shipkeep/domain';

import type {
  RepositoryConfig,
  RepositoryLocation,
  RepositorySource,
} from '../../apps/application/ports';
import { validBranch, validCommit, validConfigPath } from '../domain/github-api';

import {
  GIT_TRANSACTION,
  GITHUB_API,
  GITHUB_APP_STORE,
  type GitTransaction,
  type GithubApi,
  type GithubAppStore,
} from './ports';

/**
 * A Git application's shipkeep.yml, read through the organization's GitHub App (ADR 0031). The
 * installation must be one of the App's that GitHub has not suspended. Each read mints a token for
 * the one repository with `contents: read`, and revokes it once read. The repository is found by
 * GitHub's identifier, so a renamed repository is still the same one, and a repository the
 * installation no longer reaches is refused. GitHub is asked outside any transaction.
 */
@Injectable()
export class GithubSources implements RepositorySource {
  constructor(
    @Inject(GITHUB_APP_STORE) private readonly store: GithubAppStore,
    @Inject(GITHUB_API) private readonly github: GithubApi,
    @Inject(GIT_TRANSACTION) private readonly transaction: GitTransaction,
  ) {}

  async read(
    organizationId: string,
    location: RepositoryLocation,
    commit?: string,
  ): Promise<RepositoryConfig> {
    if (!validBranch(location.branch))
      throw new InvalidInputError('invalid_branch', 'This is not a branch name Git allows.');
    if (!validConfigPath(location.configPath))
      throw new InvalidInputError(
        'invalid_config_path',
        'The configuration path must be a relative path to a .yml or .yaml file, without .. segments.',
      );
    if (commit !== undefined && !validCommit(commit))
      throw new InvalidInputError('invalid_commit', 'This is not a full commit hash.');
    const found = await this.transaction.runTenant(organizationId, async () => ({
      app: await this.store.credentials(organizationId),
      installations: await this.store.activeInstallations(organizationId),
    }));
    if (!found.app)
      throw new ConflictError(
        'github_app_missing',
        'This organization has no GitHub App yet: create it from its integrations first.',
      );
    if (!found.installations.includes(location.installationId))
      throw new InvalidInputError(
        'github_installation_unavailable',
        'The GitHub App is not installed there, or GitHub suspended or removed that installation.',
      );
    const jwt = this.github.appJwt(found.app.appId, found.app.privateKey, new Date());
    const { token } = await this.github.installationToken(jwt, location.installationId, {
      repositoryIds: [location.repositoryId],
      permissions: { contents: 'read', metadata: 'read' },
    });
    try {
      const repository = await this.github.repository(
        token,
        location.installationId,
        location.repositoryId,
      );
      if (!repository)
        throw new InvalidInputError(
          'github_repository_unavailable',
          'The GitHub App does not reach this repository: add it to the installation on GitHub.',
        );
      const head =
        commit ?? (await this.github.branchHead(token, repository.fullName, location.branch));
      if (!head)
        throw new InvalidInputError(
          'github_branch_not_found',
          'This branch does not exist in the repository.',
          { branch: location.branch },
        );
      const text = await this.github.file(token, repository.fullName, location.configPath, head);
      if (text === undefined)
        throw new InvalidInputError(
          'github_config_not_found',
          'The repository has no file at this path on that commit.',
          { configPath: location.configPath, commit: head },
        );
      return { fullName: repository.fullName, commitSha: head, text };
    } finally {
      await this.github.revoke(token);
    }
  }
}
