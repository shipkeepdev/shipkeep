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
import { FleetAdministration } from '../application/fleet-administration';

import {
  FleetOrganizationPathDto,
  JoinTokenIssuedDto,
  joinTokenIssuedDto,
  nodeDto,
  NodePageDto,
  NodePageQueryDto,
  NodePathDto,
  RemoveNodeDto,
} from './fleet-administration.dto';

/**
 * Session-only fleet administration (PLAN M2.7a). Join tokens have no encrypted retry: a lost
 * response is answered by issuing a new token, never by replaying an enrollment secret.
 */
@ApiTags('fleet')
@ApiCookieAuth('session')
@Controller('organizations')
export class FleetAdministrationController {
  constructor(private readonly fleet: FleetAdministration) {}

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
