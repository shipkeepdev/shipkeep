import { Body, Controller, Param, Req, UseInterceptors } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { ResourceCommands } from '../application/resource-commands';

import { ResourceMutation } from './resource-mutation';
import { ResourceReplayInterceptor } from './resource-replay.interceptor';
import { EnvironmentSettingsDto, ProjectSettingsDto } from './resource-settings.dto';
import {
  EnvironmentDto,
  EnvironmentPathDto,
  OrganizationPathDto,
  ProjectDto,
  ProjectPathDto,
  environmentDto,
  projectDto,
} from './resource.dto';

@ApiTags('organizations')
@Controller('organizations')
@UseInterceptors(ResourceReplayInterceptor)
export class ResourceMutationController {
  constructor(private readonly commands: ResourceCommands) {}

  @ResourceMutation(':organizationId/projects', 'project.create', 'organization', 201)
  @ApiCreatedResponse({ type: ProjectDto })
  async createProject(
    @Req() request: IdentityRequest,
    @Param() path: OrganizationPathDto,
    @Body() body: ProjectSettingsDto,
  ): Promise<ProjectDto> {
    return projectDto(
      await this.commands.createProject(resourceContext(request), path.organizationId, body),
    );
  }

  @ResourceMutation(':organizationId/projects/:projectId/settings', 'project.update', 'project')
  @ApiOkResponse({ type: ProjectDto })
  async updateProject(
    @Req() request: IdentityRequest,
    @Param() path: ProjectPathDto,
    @Body() body: ProjectSettingsDto,
  ): Promise<ProjectDto> {
    return projectDto(await this.commands.updateProject(resourceContext(request), path, body));
  }

  @ResourceMutation(
    ':organizationId/projects/:projectId/environments',
    'environment.create',
    'project',
    201,
  )
  @ApiCreatedResponse({ type: EnvironmentDto })
  async createEnvironment(
    @Req() request: IdentityRequest,
    @Param() path: ProjectPathDto,
    @Body() body: EnvironmentSettingsDto,
  ): Promise<EnvironmentDto> {
    return environmentDto(
      await this.commands.createEnvironment(resourceContext(request), path, body),
    );
  }

  @ResourceMutation(
    ':organizationId/projects/:projectId/environments/:environmentId/settings',
    'environment.update',
    'environment',
  )
  @ApiOkResponse({ type: EnvironmentDto })
  async updateEnvironment(
    @Req() request: IdentityRequest,
    @Param() path: EnvironmentPathDto,
    @Body() body: EnvironmentSettingsDto,
  ): Promise<EnvironmentDto> {
    return environmentDto(
      await this.commands.updateEnvironment(resourceContext(request), path, body),
    );
  }
}
