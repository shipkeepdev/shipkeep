import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { ApplicationTarget } from '../../apps/domain/application';
import { ApplicationPathDto } from '../../apps/interface/application.dto';
import { AllowApiToken } from '../../identity/interface/api-token-access';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { RequireTenant } from '../../identity/interface/route-access';
import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { DeploymentCommands } from '../application/deployment-commands';

import { agentActionDto, AgentActionPageDto, AgentActionPageQueryDto } from './agent-action.dto';
import {
  DeploymentDto,
  deploymentDto,
  DeploymentListDto,
  DeploymentPathDto,
  QueuedDeploymentDto,
  releaseDto,
  ReleaseListDto,
  replicaDto,
  ReplicaListDto,
} from './deployment.dto';

const APPLICATION =
  ':organizationId/projects/:projectId/environments/:environmentId/applications/:applicationId';

/** Releases and deployments of one application (SPEC 8 resources). */
@ApiTags('deployments')
@ApiCookieAuth('session')
@ApiBearerAuth('apiToken')
@IdentityAttemptLimit('api')
@Controller('organizations')
export class DeploymentController {
  constructor(private readonly deployments: DeploymentCommands) {}

  @Post(`${APPLICATION}/deployments`)
  @HttpCode(201)
  @RequireTenant('deploy.run', 'environment')
  @AllowApiToken('deploy.run')
  @ApiCreatedResponse({ type: QueuedDeploymentDto })
  async deploy(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationPathDto,
  ): Promise<QueuedDeploymentDto> {
    const queued = await this.deployments.deploy(
      resourceContext(request),
      target(path),
      path.applicationId,
    );
    return { release: releaseDto(queued.release), deployment: deploymentDto(queued.deployment) };
  }

  @Get(`${APPLICATION}/deployments`)
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  @ApiOkResponse({ type: DeploymentListDto })
  async listDeployments(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationPathDto,
  ): Promise<DeploymentListDto> {
    const items = await this.deployments.list(
      resourceContext(request),
      target(path),
      path.applicationId,
    );
    return { items: items.map(deploymentDto) };
  }

  @Get(`${APPLICATION}/deployments/:deploymentId`)
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  @ApiOkResponse({ type: DeploymentDto })
  async getDeployment(
    @Req() request: IdentityRequest,
    @Param() path: DeploymentPathDto,
  ): Promise<DeploymentDto> {
    return deploymentDto(
      await this.deployments.get(
        resourceContext(request),
        target(path),
        path.applicationId,
        path.deploymentId,
      ),
    );
  }

  @Post(`${APPLICATION}/deployments/:deploymentId/cancel`)
  @HttpCode(200)
  @RequireTenant('deploy.run', 'environment')
  @AllowApiToken('deploy.run')
  @ApiOkResponse({ type: DeploymentDto })
  async cancelDeployment(
    @Req() request: IdentityRequest,
    @Param() path: DeploymentPathDto,
  ): Promise<DeploymentDto> {
    return deploymentDto(
      await this.deployments.cancel(
        resourceContext(request),
        target(path),
        path.applicationId,
        path.deploymentId,
      ),
    );
  }

  @Post(`${APPLICATION}/deployments/:deploymentId/rollback`)
  @HttpCode(201)
  @RequireTenant('deploy.run', 'environment')
  @AllowApiToken('deploy.run')
  @ApiCreatedResponse({ type: QueuedDeploymentDto })
  async rollback(
    @Req() request: IdentityRequest,
    @Param() path: DeploymentPathDto,
  ): Promise<QueuedDeploymentDto> {
    const queued = await this.deployments.rollback(
      resourceContext(request),
      target(path),
      path.applicationId,
      path.deploymentId,
    );
    return { release: releaseDto(queued.release), deployment: deploymentDto(queued.deployment) };
  }

  @Get(`${APPLICATION}/replicas`)
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  @ApiOkResponse({ type: ReplicaListDto })
  async listReplicas(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationPathDto,
  ): Promise<ReplicaListDto> {
    const items = await this.deployments.replicas(
      resourceContext(request),
      target(path),
      path.applicationId,
    );
    return { items: items.map(replicaDto) };
  }

  /** Agent actions requested by the application's deployments, refusals included (#263). */
  @Get(`${APPLICATION}/agent-actions`)
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  @ApiOkResponse({ type: AgentActionPageDto })
  async listAgentActions(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationPathDto,
    @Query() query: AgentActionPageQueryDto,
  ): Promise<AgentActionPageDto> {
    const page = await this.deployments.actions(
      resourceContext(request),
      target(path),
      path.applicationId,
      query.cursor,
      query.limit,
    );
    return { items: page.items.map(agentActionDto), nextCursor: page.nextCursor };
  }

  @Get(`${APPLICATION}/releases`)
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  @ApiOkResponse({ type: ReleaseListDto })
  async listReleases(
    @Req() request: IdentityRequest,
    @Param() path: ApplicationPathDto,
  ): Promise<ReleaseListDto> {
    const items = await this.deployments.releases(
      resourceContext(request),
      target(path),
      path.applicationId,
    );
    return { items: items.map(releaseDto) };
  }
}

function target(path: ApplicationPathDto): ApplicationTarget {
  return {
    organizationId: path.organizationId,
    projectId: path.projectId,
    environmentId: path.environmentId,
  };
}
