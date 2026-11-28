import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiAcceptedResponse,
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
import { AgentUpgrades } from '../application/agent-upgrades';
import { FleetAdministration } from '../application/fleet-administration';

import {
  AgentUpgradeDto,
  agentUpgradeDto,
  AgentUpgradeOverviewDto,
  agentUpgradeOverviewDto,
  FleetOrganizationPathDto,
  JoinTokenIssuedDto,
  joinTokenIssuedDto,
  nodeDto,
  NodePageDto,
  NodePageQueryDto,
  NodeDto,
  NodePathDto,
  NodeReadoptedDto,
  NodeReadoptionPageDto,
  nodeReadoptionDto,
  ReadoptNodeDto,
  RemoveNodeDto,
  SetNodePublicAddressesDto,
  StartAgentUpgradeDto,
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
    private readonly upgrades: AgentUpgrades,
    private readonly config: AppConfig,
  ) {}

  /** The agents' target version, the servers still on an older release, and the newest rollout. */
  @Get(':organizationId/agent-upgrades')
  @RequireTenant('node.manage', 'organization')
  @IdentityAttemptLimit('api')
  @ApiOkResponse({ type: AgentUpgradeOverviewDto })
  async agentUpgrades(
    @Req() request: IdentityRequest,
    @Param() path: FleetOrganizationPathDto,
  ): Promise<AgentUpgradeOverviewDto> {
    return agentUpgradeOverviewDto(
      await this.upgrades.overview(resourceContext(request), path.organizationId),
    );
  }

  /** Upgrades every agent on an older release to the control plane's version, one at a time. */
  @Post(':organizationId/agent-upgrades')
  @HttpCode(202)
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
  @ApiAcceptedResponse({ type: AgentUpgradeDto })
  async startAgentUpgrade(
    @Req() request: IdentityRequest,
    @Param() path: FleetOrganizationPathDto,
    @Body() body: StartAgentUpgradeDto,
  ): Promise<AgentUpgradeDto> {
    return agentUpgradeDto(
      await this.upgrades.start(resourceContext(request), path.organizationId, body.version),
    );
  }

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

  /**
   * Registers the certificate the node presented after a restore rolled its registered one back
   * (#487, SPEC 3.1): the caller's password and second factor, like a join token, and the serial of
   * the certificate they reviewed (#545). Session only.
   */
  @Post(':organizationId/nodes/:nodeId/readopt')
  @HttpCode(200)
  @RequireTenant('node.manage', 'organization')
  @IdentityAttemptLimit('token')
  @ApiHeader({ name: 'Origin', required: true })
  @ApiHeader({ name: 'X-Shipkeep-CSRF', required: true })
  @ApiOkResponse({ type: NodeReadoptedDto })
  async readoptNode(
    @Req() request: IdentityRequest,
    @Param() path: NodePathDto,
    @Body() body: ReadoptNodeDto,
  ): Promise<NodeReadoptedDto> {
    const readopted = await this.fleet.readoptNode(
      resourceContext(request),
      path.organizationId,
      path.nodeId,
      body.certificateSerial,
      new Secret(body.password),
      factorInput(body),
    );
    return {
      certificateSerial: readopted.serial,
      certificateNotAfter: readopted.notAfter.toISOString(),
    };
  }

  /** The certificates waiting to be re-adopted, one per server at most (#487). */
  @Get(':organizationId/node-readoptions')
  @RequireTenant('node.manage', 'organization')
  @ApiOkResponse({ type: NodeReadoptionPageDto })
  async listReadoptions(
    @Req() request: IdentityRequest,
    @Param() path: FleetOrganizationPathDto,
  ): Promise<NodeReadoptionPageDto> {
    const pending = await this.fleet.listReadoptions(resourceContext(request), path.organizationId);
    return { items: pending.map(nodeReadoptionDto) };
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

  @Get(':organizationId/nodes/:nodeId')
  @RequireTenant('node.manage', 'organization')
  @IdentityAttemptLimit('api')
  @ApiOkResponse({ type: NodeDto })
  async getNode(@Req() request: IdentityRequest, @Param() path: NodePathDto): Promise<NodeDto> {
    return nodeDto(
      await this.fleet.getNode(resourceContext(request), path.organizationId, path.nodeId),
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
