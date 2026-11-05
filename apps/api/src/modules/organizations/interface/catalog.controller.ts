import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { AllowApiToken } from '../../identity/interface/api-token-access';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { AllowAccount, RequireTenant } from '../../identity/interface/route-access';
import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { CatalogQueries } from '../application/catalog-queries';

import {
  CatalogQueryDto,
  environmentDto,
  EnvironmentDto,
  EnvironmentPageDto,
  EnvironmentPathDto,
  organizationDto,
  OrganizationDto,
  OrganizationPageDto,
  OrganizationPathDto,
  projectDto,
  ProjectDto,
  ProjectPageDto,
  ProjectPathDto,
} from './resource.dto';

@ApiTags('organizations')
@ApiCookieAuth('session')
@IdentityAttemptLimit('api')
@Controller('organizations')
export class CatalogController {
  constructor(private readonly queries: CatalogQueries) {}

  @Get()
  @AllowAccount()
  @ApiOkResponse({ type: OrganizationPageDto })
  async listOrganizations(
    @Req() request: IdentityRequest,
    @Query() query: CatalogQueryDto,
  ): Promise<OrganizationPageDto> {
    const page = await this.queries.organizations(resourceContext(request), query);
    return { ...page, items: page.items.map(organizationDto) };
  }
  @Get(':organizationId')
  @RequireTenant('organization.read', 'organization')
  @AllowApiToken('organization.read')
  @ApiBearerAuth('apiToken')
  @ApiOkResponse({ type: OrganizationDto })
  async getOrganization(
    @Req() request: IdentityRequest,
    @Param() path: OrganizationPathDto,
  ): Promise<OrganizationDto> {
    return organizationDto(
      await this.queries.organization(resourceContext(request), path.organizationId),
    );
  }
  @Get(':organizationId/projects')
  @RequireTenant('organization.read', 'organization')
  @ApiOkResponse({ type: ProjectPageDto })
  async listProjects(
    @Req() request: IdentityRequest,
    @Param() path: OrganizationPathDto,
    @Query() query: CatalogQueryDto,
  ): Promise<ProjectPageDto> {
    const page = await this.queries.projects(resourceContext(request), path.organizationId, query);
    return { ...page, items: page.items.map(projectDto) };
  }
  @Get(':organizationId/projects/:projectId')
  @RequireTenant('project.read', 'project')
  @AllowApiToken('project.read')
  @ApiBearerAuth('apiToken')
  @ApiOkResponse({ type: ProjectDto })
  async getProject(
    @Req() request: IdentityRequest,
    @Param() path: ProjectPathDto,
  ): Promise<ProjectDto> {
    return projectDto(await this.queries.project(resourceContext(request), path));
  }
  @Get(':organizationId/projects/:projectId/environments')
  @RequireTenant('project.read', 'project')
  @ApiOkResponse({ type: EnvironmentPageDto })
  async listEnvironments(
    @Req() request: IdentityRequest,
    @Param() path: ProjectPathDto,
    @Query() query: CatalogQueryDto,
  ): Promise<EnvironmentPageDto> {
    const page = await this.queries.environments(resourceContext(request), path, query);
    return { ...page, items: page.items.map(environmentDto) };
  }
  @Get(':organizationId/projects/:projectId/environments/:environmentId')
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  @ApiBearerAuth('apiToken')
  @ApiOkResponse({ type: EnvironmentDto })
  async getEnvironment(
    @Req() request: IdentityRequest,
    @Param() path: EnvironmentPathDto,
  ): Promise<EnvironmentDto> {
    return environmentDto(await this.queries.environment(resourceContext(request), path));
  }
}
