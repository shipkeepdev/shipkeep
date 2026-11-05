import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Secret } from '@shipkeep/domain';

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
    const items = nodes.slice(0, query.limit).map(nodeDto);
    return { items, nextCursor: items.length === query.limit ? (items.at(-1)?.id ?? null) : null };
  }
}
