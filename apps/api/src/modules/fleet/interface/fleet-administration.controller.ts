import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Secret } from '@shipkeep/domain';

import { AllowApiToken } from '../../identity/interface/api-token-access';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { factorInput, ReauthenticateMfaDto } from '../../identity/interface/mfa.dto';
import { RequireTenant } from '../../identity/interface/route-access';
import { type IdentityRequest, resourceContext } from '../../identity/interface/session-http';
import { AppConfig } from '../../../platform/config/app-config';
import { FleetAdministration } from '../application/fleet-administration';

import {
  FleetOrganizationPathDto,
  JoinTokenIssuedDto,
  joinTokenIssuedDto,
  nodeDto,
  NodePageDto,
  NodePageQueryDto,
  NodeDto,
  NodePathDto,
  RemoveNodeDto,
  SetNodePublicAddressesDto,
} from './fleet-administration.dto';

/**
 * Session-only fleet administration (PLAN M2.7a). Join tokens have no encrypted retry: a lost
 * response is answered by issuing a new token, never by replaying an enrollment secret.
 */
@ApiTags('fleet')
@ApiCookieAuth('session')
@Controller('organizations')
export class FleetAdministrationController {
  constructor(
    private readonly fleet: FleetAdministration,
    private readonly config: AppConfig,
  ) {}

  @Post(':organizationId/join-tokens')
  @HttpCode(201)
  @RequireTenant('node.manage', 'organization')
  @IdentityAttemptLimit('token')
  @ApiHeader({ name: 'Origin', required: true })
  @ApiHeader({ name: 'X-Shipkeep-CSRF', required: true })
  @ApiCreatedResponse({ type: JoinTokenIssuedDto })
  async issueJoinToken(
    @Req() request: IdentityRequest,
    @Param() path: FleetOrganizationPathDto,
    @Body() body: ReauthenticateMfaDto,
  ): Promise<JoinTokenIssuedDto> {
    return joinTokenIssuedDto(
      await this.fleet.issueJoinToken(
        resourceContext(request),
        path.organizationId,
        new Secret(body.password),
        factorInput(body),
      ),
      // The name agents verify in the gateway certificate, with the gateway's port.
      `${this.config.get('AGENT_GATEWAY_SERVER_NAME')}:${this.config.get('AGENT_GATEWAY_ADDR').split(':').at(-1) ?? '7443'}`,
    );
  }

  /** Destructive: requires a confirmation token for this node (SPEC 3.6, rule 7). */
  @Post(':organizationId/nodes/:nodeId/remove')
  @HttpCode(204)
  @RequireTenant('node.manage', 'organization')
  @AllowApiToken('node.manage')
  @IdentityAttemptLimit('api')
  @ApiBearerAuth('apiToken')
  @ApiHeader({ name: 'Origin', required: false, description: 'Required for session requests.' })
  @ApiHeader({
    name: 'X-Shipkeep-CSRF',
    required: false,
    description: 'Required for session requests.',
  })
  @ApiNoContentResponse()
  async removeNode(
    @Req() request: IdentityRequest,
    @Param() path: NodePathDto,
    @Body() body: RemoveNodeDto,
  ): Promise<void> {
    await this.fleet.removeNode(
      resourceContext(request),
      path.organizationId,
      path.nodeId,
      new Secret(body.confirmation),
    );
  }

  /** Replaces the node's declared public addresses, compared by the domain check (M3.6b1). */
  @Post(':organizationId/nodes/:nodeId/public-addresses')
  @HttpCode(200)
  @RequireTenant('node.manage', 'organization')
  @AllowApiToken('node.manage')
  @IdentityAttemptLimit('api')
  @ApiBearerAuth('apiToken')
  @ApiHeader({ name: 'Origin', required: false, description: 'Required for session requests.' })
  @ApiHeader({
    name: 'X-Shipkeep-CSRF',
    required: false,
    description: 'Required for session requests.',
  })
  @ApiOkResponse({ type: NodeDto })
  async setNodePublicAddresses(
    @Req() request: IdentityRequest,
    @Param() path: NodePathDto,
    @Body() body: SetNodePublicAddressesDto,
  ): Promise<NodeDto> {
    return nodeDto(
      await this.fleet.setPublicAddresses(
        resourceContext(request),
        path.organizationId,
        path.nodeId,
        body.publicAddresses,
      ),
    );
  }

  @Get(':organizationId/nodes')
  @RequireTenant('node.manage', 'organization')
  @IdentityAttemptLimit('api')
  @ApiOkResponse({ type: NodePageDto })
  async listNodes(
    @Req() request: IdentityRequest,
    @Param() path: FleetOrganizationPathDto,
    @Query() query: NodePageQueryDto,
  ): Promise<NodePageDto> {
    const nodes = await this.fleet.listNodes(
      resourceContext(request),
      path.organizationId,
      query.cursor,
    );
    const now = new Date();
    const items = nodes.slice(0, query.limit).map((node) => nodeDto(node, now));
    return { items, nextCursor: items.length === query.limit ? (items.at(-1)?.id ?? null) : null };
  }
}
