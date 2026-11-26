import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCookieAuth,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Secret } from '@shipkeep/domain';

import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { RequireTenant } from '../../identity/interface/route-access';
import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { DeploymentCommands } from '../application/deployment-commands';
import { UntrackedContainers } from '../application/untracked-containers';

import {
  nodeReplicaDto,
  NodeReplicaListDto,
  NodeReplicaPathDto,
  RemoveUntrackedContainerDto,
  untrackedContainerDto,
  UntrackedContainerListDto,
  UntrackedContainerPathDto,
  UntrackedRemovalDto,
} from './node-replica.dto';

/** What runs on one server, for its page (#264). Session-only, like the server list. */
@ApiTags('fleet')
@ApiCookieAuth('session')
@Controller('organizations')
export class NodeReplicasController {
  constructor(
    private readonly deployments: DeploymentCommands,
    private readonly untracked: UntrackedContainers,
  ) {}

  @Get(':organizationId/nodes/:nodeId/replicas')
  @RequireTenant('node.manage', 'organization')
  @IdentityAttemptLimit('api')
  @ApiOkResponse({ type: NodeReplicaListDto })
  async listNodeReplicas(
    @Req() request: IdentityRequest,
    @Param() path: NodeReplicaPathDto,
  ): Promise<NodeReplicaListDto> {
    const { items, truncated } = await this.deployments.nodeReplicas(
      resourceContext(request),
      path.organizationId,
      path.nodeId,
    );
    return { items: items.map(nodeReplicaDto), truncated };
  }
  /** Containers the server runs that no placed replica matches, of known applications (#501). */
  @Get(':organizationId/nodes/:nodeId/untracked-containers')
  @RequireTenant('node.manage', 'organization')
  @IdentityAttemptLimit('api')
  @ApiOkResponse({ type: UntrackedContainerListDto })
  async listUntrackedContainers(
    @Req() request: IdentityRequest,
    @Param() path: NodeReplicaPathDto,
  ): Promise<UntrackedContainerListDto> {
    const items = await this.untracked.list(
      resourceContext(request),
      path.organizationId,
      path.nodeId,
    );
    return { items: items.map(untrackedContainerDto) };
  }

  /**
   * Destructive: asks the server to remove one untracked container, without its volumes, on a
   * confirmation token for `node.container.remove` (SPEC 3.6, rule 7). Answers once it is asked.
   */
  @Post(':organizationId/nodes/:nodeId/untracked-containers/:name/remove')
  @HttpCode(202)
  @RequireTenant('node.manage', 'organization')
  @IdentityAttemptLimit('api')
  @ApiHeader({ name: 'Origin', required: true })
  @ApiHeader({ name: 'X-Shipkeep-CSRF', required: true })
  @ApiAcceptedResponse({ type: UntrackedRemovalDto })
  async removeUntrackedContainer(
    @Req() request: IdentityRequest,
    @Param() path: UntrackedContainerPathDto,
    @Body() body: RemoveUntrackedContainerDto,
  ): Promise<UntrackedRemovalDto> {
    return this.untracked.remove(
      resourceContext(request),
      path.organizationId,
      path.nodeId,
      path.name,
      new Secret(body.confirmation),
    );
  }
}
