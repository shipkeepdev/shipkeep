import { Controller, Get, Param, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { RequireTenant } from '../../identity/interface/route-access';
import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { DeploymentCommands } from '../application/deployment-commands';

import { nodeReplicaDto, NodeReplicaListDto, NodeReplicaPathDto } from './node-replica.dto';

/** What runs on one server, for its page (#264). Session-only, like the server list. */
@ApiTags('fleet')
@ApiCookieAuth('session')
@Controller('organizations')
export class NodeReplicasController {
  constructor(private readonly deployments: DeploymentCommands) {}

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
}
