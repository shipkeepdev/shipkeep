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
import type { ApplicationTarget } from '../domain/application';

import {
  ApplicationDto,
  applicationDto,
  ApplicationEnvironmentPathDto,
  ApplicationListDto,
  ApplicationPathDto,
  CreateApplicationDto,
  DomainListDto,
  UpdateApplicationConfigDto,
} from './application.dto';

const APPLICATIONS = ':organizationId/projects/:projectId/environments/:environmentId/applications';

/** Applications of an environment. Writes are idempotent by name and by configuration hash. */
@ApiTags('applications')
@ApiCookieAuth('session')
@ApiBearerAuth('apiToken')
@IdentityAttemptLimit('api')
@Controller('organizations')
export class ApplicationController {
  constructor(private readonly applications: ApplicationCommands) {}

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
    return { items: items.map((item) => ({ ...item, addresses: [...item.addresses] })) };
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
