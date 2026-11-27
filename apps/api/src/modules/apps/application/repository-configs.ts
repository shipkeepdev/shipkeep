import { Inject, Injectable } from '@nestjs/common';
import { parseShipkeepConfig } from '@shipkeep/config-schema';
import {
  ConflictError,
  createEvent,
  InvalidInputError,
  NotFoundError,
  type Permission,
} from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import {
  resourceActor,
  type ResourceSecurityContext as SecurityContext,
} from '../../identity/application/resource-security-context';
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
import {
  configFileChanged,
  type DiffLine,
  lineDiff,
  rewriteConfigFile,
} from '../domain/config-file';

import {
  APPLICATION_STORE,
  APPLICATION_TRANSACTION,
  type ApplicationStore,
  type ApplicationTransaction,
  type GitWriteMode,
  CONTROL_PLANE_HOST,
  REPOSITORY_SOURCE,
  type RepositoryConfigFile,
  type RepositorySource,
  type WrittenConfigChange,
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
  /** How writing it goes: a pull request, or a commit on the branch (`gitWriteMode`). */
  readonly writeMode: GitWriteMode;
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
    private readonly events: DomainEventBus,
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
    const writeMode = await this.transaction.runTenant(target.organizationId, () =>
      this.store.writeMode(target),
    );
    const { repository } = application;
    const file = await this.repositories.readForChange(target.organizationId, location(repository));
    if (file.blobSha !== blobSha) throw configFileChanged();
    const changedText = rewriteConfigFile(file.text, document);
    return {
      writeMode,
      ...file,
      branch: repository.branch,
      configPath: repository.configPath,
      changedText,
      diff: lineDiff(file.text, changedText),
    };
  }

  /**
   * Writes a change of the file (#214): a pull request, or a commit when the project says so
   * (`gitWriteMode`); a commit a protected branch refuses becomes a pull request. Nothing changes
   * in Shipkeep until the branch receives it: the push applies it, like any other. Audited as
   * `application.config_written`, with where it went. A change that leaves the file as it is
   * answers `config_unchanged`, one made against another text `config_file_changed`.
   */
  async change(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    document: Record<string, unknown>,
    blobSha: string,
    now = new Date(),
  ): Promise<WrittenConfigChange> {
    const config = applicationConfig(document, 'git');
    assertDomainsAvailable(config.config, [this.controlPlaneHost]);
    const application = await this.gitApplication(context, 'deploy.run', target, applicationId);
    assertSameName(application, config);
    const mode = await this.transaction.runTenant(target.organizationId, () =>
      this.store.writeMode(target),
    );
    const { repository } = application;
    const file = await this.repositories.readForChange(target.organizationId, location(repository));
    if (file.blobSha !== blobSha) throw configFileChanged();
    const text = rewriteConfigFile(file.text, document);
    if (text === file.text)
      throw new InvalidInputError('config_unchanged', 'This change leaves the file as it is.');
    // No person in the commit or the pull request: the repository may be public. The audit log
    // keeps who asked for it.
    const written = await this.repositories.writeConfig(
      target.organizationId,
      location(repository),
      {
        blobSha,
        text,
        title: `Change the configuration of ${application.name}`,
        body: `Made in Shipkeep, in ${repository.configPath}. Once on ${repository.branch}, it deploys like any other push, unless the environment is protected.`,
        mode,
      },
    );
    await this.transaction.runTenant(target.organizationId, () =>
      this.events.publish([
        createEvent({
          type: 'application.config_written',
          organizationId: application.organizationId,
          actor: resourceActor(context),
          target: { type: 'application', id: application.id },
          payload: {
            projectId: application.projectId,
            environmentId: application.environmentId,
            name: application.name,
            repository: file.fullName,
            branch: repository.branch,
            configPath: repository.configPath,
            fromCommit: file.commitSha,
            via: written.via,
            commitSha: written.commitSha,
            url: written.url,
            ...(written.via === 'pull_request'
              ? { pullRequest: written.number, pullRequestBranch: written.branch }
              : {}),
          },
          occurredAt: now,
        }),
      ]),
    );
    return written;
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

function location(repository: ApplicationRepository) {
  return {
    installationId: repository.installationId,
    repositoryId: repository.repositoryId,
    branch: repository.branch,
    configPath: repository.configPath,
  };
}
