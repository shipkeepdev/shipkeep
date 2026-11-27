import { Inject, Injectable } from '@nestjs/common';
import { MAX_CONFIG_BYTES, parseShipkeepConfig } from '@shipkeep/config-schema';
import { ConflictError, InvalidInputError, NotFoundError, type Permission } from '@shipkeep/domain';

import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import type { ResourceSecurityContext as SecurityContext } from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import {
  type Application,
  type ApplicationRepository,
  type ApplicationTarget,
  applicationConfig,
  assertDomainsAvailable,
  assertSameName,
  canonicalJson,
} from '../domain/application';
import { type DiffLine, lineDiff, rewriteConfigFile } from '../domain/config-file';

import {
  APPLICATION_STORE,
  APPLICATION_TRANSACTION,
  type ApplicationStore,
  type ApplicationTransaction,
  CONTROL_PLANE_HOST,
  REPOSITORY_SOURCE,
  type RepositoryConfigFile,
  type RepositorySource,
} from './ports';

/** A Git application's shipkeep.yml as its repository holds it now (#214). */
export interface RepositoryConfigView extends RepositoryConfigFile {
  readonly branch: string;
  readonly configPath: string;
  /** The commit the application's configuration was last read from. */
  readonly appliedCommitSha: string;
  /** Whether the file is a valid configuration for this application. */
  readonly valid: boolean;
  /** Whether the application's configuration is the file's: false is drift. */
  readonly applied: boolean;
}

/** What a change would write, before it is written (#214). */
export interface RepositoryConfigPreview extends RepositoryConfigFile {
  readonly branch: string;
  readonly configPath: string;
  /** The file's text with the change. */
  readonly changedText: string;
  readonly diff: readonly DiffLine[];
}

/**
 * The shipkeep.yml of a Git application, read in its repository and changed from the interface
 * (#214, ADR 0031): the file is the source of truth, so a change is a pull request or a commit,
 * never an edit of the stored configuration. Reading needs `environment.read`; a change needs
 * `deploy.run`, like an image application's. GitHub is asked outside any transaction.
 */
@Injectable()
export class RepositoryConfigs {
  constructor(
    @Inject(APPLICATION_STORE) private readonly store: ApplicationStore,
    @Inject(APPLICATION_TRANSACTION) private readonly transaction: ApplicationTransaction,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    @Inject(CONTROL_PLANE_HOST) private readonly controlPlaneHost: string,
    @Inject(REPOSITORY_SOURCE) private readonly repositories: RepositorySource,
  ) {}

  /** The file at the branch's head, and whether the application runs what it holds. */
  async view(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
  ): Promise<RepositoryConfigView> {
    const application = await this.gitApplication(
      context,
      'environment.read',
      target,
      applicationId,
    );
    const { repository } = application;
    const file = await this.repositories.readForChange(target.organizationId, location(repository));
    let valid = false;
    let applied = false;
    const parsed = parseShipkeepConfig(file.text);
    if (parsed.ok)
      try {
        const config = applicationConfig(parsed.config, 'git');
        // What a change of it would be refused for makes it invalid here too.
        assertDomainsAvailable(config.config, [this.controlPlaneHost]);
        valid = config.name === application.name;
        applied = valid && canonicalJson(config.config) === canonicalJson(application.config);
      } catch {
        valid = false;
      }
    return {
      ...file,
      branch: repository.branch,
      configPath: repository.configPath,
      appliedCommitSha: repository.commitSha,
      valid,
      applied,
    };
  }

  /**
   * What `document` would change in the file, read with `blobSha`: its text and its lines. A file
   * changed since answers `config_file_changed`, and the change is reviewed again.
   */
  async preview(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    document: Record<string, unknown>,
    blobSha: string,
  ): Promise<RepositoryConfigPreview> {
    const config = applicationConfig(document, 'git');
    assertDomainsAvailable(config.config, [this.controlPlaneHost]);
    const application = await this.gitApplication(context, 'deploy.run', target, applicationId);
    assertSameName(application, config);
    const { repository } = application;
    const file = await this.repositories.readForChange(target.organizationId, location(repository));
    if (file.blobSha !== blobSha) throw fileChanged();
    const changedText = writableText(file.text, document);
    return {
      ...file,
      branch: repository.branch,
      configPath: repository.configPath,
      changedText,
      diff: lineDiff(file.text, changedText),
    };
  }

  /** A Git application, once the caller's access is checked. */
  private gitApplication(
    context: SecurityContext,
    permission: Exclude<Permission, 'profile.read'>,
    target: ApplicationTarget,
    applicationId: string,
  ): Promise<Application & { readonly repository: ApplicationRepository }> {
    const scope = {
      organizationId: target.organizationId,
      projectId: target.projectId,
      environmentId: target.environmentId,
    };
    return this.accounts.run(
      context,
      async () => {
        await this.access.require(context.userId, permission, scope);
        const found = await this.transaction.runTenant(target.organizationId, () =>
          this.store.find(target, applicationId),
        );
        if (!found) throw new NotFoundError('application');
        const { repository } = found;
        if (!repository)
          throw new ConflictError(
            'application_not_from_repository',
            'This application runs an image: its configuration is edited here, not in a repository.',
          );
        return { ...found, repository };
      },
      { permission, target: scope },
    );
  }
}

/** The file changed in the repository since the change was prepared against it. */
export function fileChanged(): ConflictError {
  return new ConflictError(
    'config_file_changed',
    'The file changed in the repository since it was read: review the change again.',
  );
}

/**
 * The file's text with the change, once it reads as a configuration within the size the file may
 * have: comments kept around a longer value can take it over the limit.
 */
export function writableText(text: string, document: Record<string, unknown>): string {
  const changed = rewriteConfigFile(text, document);
  if (new TextEncoder().encode(changed).length > MAX_CONFIG_BYTES)
    throw new InvalidInputError(
      'config_file_too_large',
      `With this change, the file would exceed ${String(MAX_CONFIG_BYTES / 1024)} KiB.`,
    );
  if (!parseShipkeepConfig(changed).ok)
    throw new InvalidInputError(
      'invalid_config_file',
      'This change cannot be written into the file as it is: change it in the repository.',
    );
  return changed;
}

function location(repository: ApplicationRepository) {
  return {
    installationId: repository.installationId,
    repositoryId: repository.repositoryId,
    branch: repository.branch,
    configPath: repository.configPath,
  };
}
