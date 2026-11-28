import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, InvalidInputError, type Secret } from '@shipkeep/domain';

import type {
  RepositoryConfig,
  RepositoryConfigChange,
  RepositoryConfigFile,
  RepositoryLocation,
  RepositorySource,
  WrittenConfigChange,
} from '../../apps/application/ports';
import { configFileChanged } from '../../apps/domain/config-file';
import { type TokenScope, validBranch, validCommit, validConfigPath } from '../domain/github-api';

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
    const { token } = await this.mint(organizationId, location);
    try {
      const repository = await this.github.repository(
        token,
        location.installationId,
        location.repositoryId,
      );
      if (!repository) throw unreachable();
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

  async readForChange(
    organizationId: string,
    location: RepositoryLocation,
  ): Promise<RepositoryConfigFile> {
    if (!validBranch(location.branch) || !validConfigPath(location.configPath))
      throw new InvalidInputError(
        'invalid_repository_location',
        'This application names a branch or a path Git does not allow.',
      );
    const { token } = await this.mint(organizationId, location);
    try {
      const repository = await this.github.repository(
        token,
        location.installationId,
        location.repositoryId,
      );
      if (!repository) throw unreachable();
      const head = await this.github.branchHead(token, repository.fullName, location.branch);
      if (!head)
        throw new InvalidInputError(
          'github_branch_not_found',
          'This branch does not exist in the repository.',
          { branch: location.branch },
        );
      // At the head's commit, not the branch: the file and the commit are read together.
      const file = await this.github.fileAt(token, repository.fullName, location.configPath, head);
      if (!file)
        throw new InvalidInputError(
          'github_config_not_found',
          'The repository has no file at this path on that commit.',
          { configPath: location.configPath, commit: head },
        );
      return {
        fullName: repository.fullName,
        commitSha: head,
        text: file.text,
        blobSha: file.blobSha,
      };
    } finally {
      await this.github.revoke(token);
    }
  }

  async writeConfig(
    organizationId: string,
    location: RepositoryLocation,
    change: RepositoryConfigChange,
  ): Promise<WrittenConfigChange> {
    if (!validBranch(location.branch) || !validConfigPath(location.configPath))
      throw new InvalidInputError(
        'invalid_repository_location',
        'This application names a branch or a path Git does not allow.',
      );
    // Made by RepositoryConfigs: anything else is a programming error, not a request's.
    if (!CHANGE_ID.test(change.changeId)) throw new Error('a configuration change has no name');
    const { token } = await this.mint(organizationId, location, WRITE);
    try {
      const repository = await this.github.repository(
        token,
        location.installationId,
        location.repositoryId,
      );
      if (!repository) throw unreachable();
      const { fullName } = repository;
      const head = await this.github.branchHead(token, fullName, location.branch);
      if (!head)
        throw new InvalidInputError(
          'github_branch_not_found',
          'This branch does not exist in the repository.',
          { branch: location.branch },
        );
      const current = await this.github.fileAt(token, fullName, location.configPath, head);
      if (current?.blobSha !== change.blobSha) throw configFileChanged();
      // Every commit of the change carries its name (#214): an attempt that repeats an earlier one
      // finds what that one wrote.
      const marker = changeMarker(change.changeId);
      const message = `${change.title}\n\n${change.body}\n\n${marker}`;
      const file = {
        path: location.configPath,
        text: change.text,
        blobSha: change.blobSha,
        message,
      };
      if (change.mode === 'commit') {
        const written = await this.github.writeFile(token, fullName, {
          ...file,
          branch: location.branch,
        });
        if (written !== 'refused') return { via: 'commit', ...written };
        // Refused: the file changed meanwhile, or a rule protects the branch. On an unchanged
        // file the change becomes a pull request, the more reversible (ADR 0031).
        const now = await this.github.fileAt(token, fullName, location.configPath, location.branch);
        if (now?.blobSha !== change.blobSha) throw configFileChanged();
      }
      // The pull request's branch is named after the change, so a repeated attempt finds it.
      const branch = `shipkeep/config-${change.changeId.slice(0, 16)}`;
      const created = await this.github.createBranch(token, fullName, branch, head);
      if (created === 'refused') throw refusedChange();
      let commitSha: string;
      const at = created ? head : await this.github.branchHead(token, fullName, branch);
      if (at === head) {
        // A new branch, or one an earlier attempt made but did not write to yet.
        const written = await this.github.writeFile(token, fullName, { ...file, branch });
        if (written === 'refused') throw refusedChange();
        commitSha = written.commitSha;
      } else if (at && (await this.github.commitMessage(token, fullName, at))?.includes(marker)) {
        commitSha = at;
      } else {
        // A branch of that name holds something else: nothing is written over it.
        throw refusedChange();
      }
      const opened =
        (await this.github.openPullRequestFrom(token, fullName, branch, location.branch)) ??
        (await this.github.openPullRequest(token, fullName, {
          head: branch,
          base: location.branch,
          title: change.title,
          body: change.body,
        }));
      if (opened === 'refused') throw refusedChange();
      return { via: 'pull_request', commitSha, branch, ...opened };
    } finally {
      await this.github.revoke(token);
    }
  }

  async writtenChange(
    organizationId: string,
    location: RepositoryLocation,
    changeId: string,
  ): Promise<WrittenConfigChange | undefined> {
    if (!validBranch(location.branch) || !CHANGE_ID.test(changeId)) return undefined;
    const { token } = await this.mint(organizationId, location);
    try {
      const repository = await this.github.repository(
        token,
        location.installationId,
        location.repositoryId,
      );
      if (!repository) throw unreachable();
      const head = await this.github.branchHead(token, repository.fullName, location.branch);
      if (!head) return undefined;
      const message = await this.github.commitMessage(token, repository.fullName, head);
      if (!message?.includes(changeMarker(changeId))) return undefined;
      return {
        via: 'commit',
        commitSha: head,
        url: `https://github.com/${repository.fullName}/commit/${head}`,
      };
    } finally {
      await this.github.revoke(token);
    }
  }

  async buildAccess(
    organizationId: string,
    location: { installationId: number; repositoryId: number },
  ): Promise<{ url: string; token: Secret; expiresAt: Date }> {
    const minted = await this.mint(organizationId, location);
    let fullName: string | undefined;
    try {
      fullName = (
        await this.github.repository(minted.token, location.installationId, location.repositoryId)
      )?.fullName;
    } catch (error: unknown) {
      await this.github.revoke(minted.token);
      throw error;
    }
    if (!fullName) {
      await this.github.revoke(minted.token);
      throw unreachable();
    }
    return { url: `https://github.com/${fullName}.git`, ...minted };
  }

  async revoke(token: Secret): Promise<boolean> {
    return this.github.revoke(token);
  }

  /**
   * A token of the organization's App that reads one repository's contents, once the App and the
   * installation are checked. GitHub is asked outside any transaction.
   */
  private async mint(
    organizationId: string,
    location: { installationId: number; repositoryId: number },
    permissions: TokenScope['permissions'] = READ,
  ): Promise<{ token: Secret; expiresAt: Date }> {
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
    const minted = await this.github.installationToken(jwt, location.installationId, {
      repositoryIds: [location.repositoryId],
      permissions,
    });
    // GitHub refuses a token for a repository the installation does not include.
    if (!minted) throw unreachable();
    return minted;
  }
}

/** A change's name, as `RepositoryConfigs` makes it: a SHA-256 in hex. */
const CHANGE_ID = /^[0-9a-f]{64}$/;

/** The line every commit of a change carries, at the end of its message. */
function changeMarker(changeId: string): string {
  return `Shipkeep-Change: ${changeId}`;
}

/** What reading a repository's file needs, and what writing a change of it needs (ADR 0031). */
const READ: TokenScope['permissions'] = { contents: 'read', metadata: 'read' };
const WRITE: TokenScope['permissions'] = {
  contents: 'write',
  pull_requests: 'write',
  metadata: 'read',
};

/** GitHub took the branch but not the change: a rule of the repository refuses it. */
function refusedChange(): ConflictError {
  return new ConflictError(
    'repository_refused_change',
    'GitHub refused the change: a rule of the repository may forbid it. Change the file in the repository.',
  );
}

function unreachable(): InvalidInputError {
  return new InvalidInputError(
    'github_repository_unavailable',
    'The GitHub App does not reach this repository: add it to the installation on GitHub.',
  );
}
