import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';

import { AllowApiToken } from '../../identity/interface/api-token-access';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { RequireTenant } from '../../identity/interface/route-access';
import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { ApplicationCommands } from '../application/application-commands';
import { RepositoryConfigs } from '../application/repository-configs';
import { EnvironmentClone } from '../application/environment-clone';
import type { ApplicationTarget } from '../domain/application';

import {
  ApplicationDto,
  applicationDto,
  ApplicationEnvironmentPathDto,
  ApplicationListDto,
  ApplicationPathDto,
  ClonedEnvironmentDto,
  CloneEnvironmentDto,
  CreateApplicationDto,
  CreateGithubApplicationDto,
  DomainListDto,
  RepositoryConfigChangeDto,
  RepositoryConfigDto,
  RepositoryConfigPreviewDto,
  UpdateApplicationConfigDto,
  WrittenConfigChangeDto,
} from './application.dto';

const APPLICATIONS = ':organizationId/projects/:projectId/environments/:environmentId/applications';

/** Applications of an environment. Writes are idempotent by name and by configuration hash. */
@ApiTags('applications')
@ApiCookieAuth('session')
@ApiBearerAuth('apiToken')
@IdentityAttemptLimit('api')
@Controller('organizations')
export class ApplicationController {
  constructor(
    private readonly applications: ApplicationCommands,
    private readonly environments: EnvironmentClone,
    private readonly repositoryConfigs: RepositoryConfigs,
  ) {}
  /**
   * A new environment with the same settings and a copy of each application's configuration, not
   * deployed and without domains (issue #257). Browser sessions only: it needs three permissions.
   */
  @Post(':organizationId/projects/:projectId/environments/:environmentId/clone')
  @HttpCode(201)
  // The source is read here; creating the environment and its applications is checked inside.
  @RequireTenant('environment.read', 'environment')
  @ApiCreatedResponse({ type: ClonedEnvironmentDto })
  async cloneEnvironment(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationEnvironmentPathDto,
    @Body() body: CloneEnvironmentDto,
  ): Promise<ClonedEnvironmentDto> {
    const { environment, applications } = await this.environments.clone(
      resourceContext(request),
      target(path),
      body.name,
    );
    return {
      environmentId: environment.id,
      name: environment.name,
      applications: applications.map(applicationDto),
    };
  }

  @Get(APPLICATIONS)
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  @ApiOkResponse({ type: ApplicationListDto })
  async listApplications(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationEnvironmentPathDto,
  ): Promise<ApplicationListDto> {
    const items = await this.applications.list(resourceContext(request), target(path));
    return { items: items.map(applicationDto) };
  }

  @Post(APPLICATIONS)
  @HttpCode(201)
  @RequireTenant('deploy.run', 'environment')
  @AllowApiToken('deploy.run')
  @ApiCreatedResponse({ type: ApplicationDto })
  async createApplication(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationEnvironmentPathDto,
    @Body() body: CreateApplicationDto,
  ): Promise<ApplicationDto> {
    return applicationDto(
      await this.applications.create(resourceContext(request), target(path), body.config),
    );
  }

  @Post(`${APPLICATIONS}/github`)
  @HttpCode(201)
  @RequireTenant('deploy.run', 'environment')
  @AllowApiToken('deploy.run')
  @ApiCreatedResponse({ type: ApplicationDto })
  async createGithubApplication(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationEnvironmentPathDto,
    @Body() body: CreateGithubApplicationDto,
  ): Promise<ApplicationDto> {
    return applicationDto(
      await this.applications.createFromRepository(resourceContext(request), target(path), {
        installationId: body.installationId,
        repositoryId: body.repositoryId,
        branch: body.branch,
        configPath: body.configPath ?? 'shipkeep.yml',
      }),
    );
  }

  @Get(`${APPLICATIONS}/:applicationId`)
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  @ApiOkResponse({ type: ApplicationDto })
  async getApplication(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationPathDto,
  ): Promise<ApplicationDto> {
    return applicationDto(
      await this.applications.get(resourceContext(request), target(path), path.applicationId),
    );
  }

  @Get(`${APPLICATIONS}/:applicationId/domains`)
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  @ApiOkResponse({ type: DomainListDto })
  async listDomains(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationPathDto,
  ): Promise<DomainListDto> {
    const items = await this.applications.domains(
      resourceContext(request),
      target(path),
      path.applicationId,
    );
    return {
      items: items.map(({ certificate, ...item }) => ({
        ...item,
        addresses: [...item.addresses],
        certificate: certificate
          ? {
              notAfter: certificate.notAfter.toISOString(),
              issuer: certificate.issuer,
              observedAt: certificate.observedAt.toISOString(),
            }
          : null,
      })),
    };
  }

  /** The shipkeep.yml of a Git application in its repository, and whether it runs it (#214). */
  @Get(`${APPLICATIONS}/:applicationId/repository-config`)
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  @ApiOkResponse({ type: RepositoryConfigDto })
  async getRepositoryConfig(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationPathDto,
  ): Promise<RepositoryConfigDto> {
    return this.repositoryConfigs.view(resourceContext(request), target(path), path.applicationId);
  }

  /** What a change of that file would write, before anything is written (#214). */
  @Post(`${APPLICATIONS}/:applicationId/repository-config/preview`)
  @HttpCode(200)
  @RequireTenant('deploy.run', 'environment')
  @AllowApiToken('deploy.run')
  @ApiOkResponse({ type: RepositoryConfigPreviewDto })
  async previewRepositoryConfig(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationPathDto,
    @Body() body: RepositoryConfigChangeDto,
  ): Promise<RepositoryConfigPreviewDto> {
    const preview = await this.repositoryConfigs.preview(
      resourceContext(request),
      target(path),
      path.applicationId,
      body.config,
      body.blobSha,
    );
    return { ...preview, diff: preview.diff.map((line) => ({ ...line })) };
  }

  /**
   * Writes a change of that file to the repository, as a pull request or a commit (#214). A
   * browser session only: it writes to GitHub with the organization's App.
   */
  @Post(`${APPLICATIONS}/:applicationId/repository-config/changes`)
  @HttpCode(201)
  @RequireTenant('deploy.run', 'environment')
  @ApiCreatedResponse({ type: WrittenConfigChangeDto })
  async changeRepositoryConfig(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationPathDto,
    @Body() body: RepositoryConfigChangeDto,
  ): Promise<WrittenConfigChangeDto> {
    return this.repositoryConfigs.change(
      resourceContext(request),
      target(path),
      path.applicationId,
      body.config,
      body.blobSha,
    );
  }

  @Post(`${APPLICATIONS}/:applicationId/config`)
  @HttpCode(200)
  @RequireTenant('deploy.run', 'environment')
  @AllowApiToken('deploy.run')
  @ApiOkResponse({ type: ApplicationDto })
  async updateApplicationConfig(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationPathDto,
    @Body() body: UpdateApplicationConfigDto,
  ): Promise<ApplicationDto> {
    return applicationDto(
      await this.applications.updateConfig(
        resourceContext(request),
        target(path),
        path.applicationId,
        body.expectedConfigSha,
        body.config,
      ),
    );
  }
}

function target(path: ApplicationEnvironmentPathDto): ApplicationTarget {
  return {
    organizationId: path.organizationId,
    projectId: path.projectId,
    environmentId: path.environmentId,
  };
}
