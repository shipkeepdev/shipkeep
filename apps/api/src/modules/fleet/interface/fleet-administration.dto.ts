import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

import { ReauthenticateMfaDto } from '../../identity/interface/mfa.dto';
import type { AgentUpgradeOverview } from '../application/agent-upgrades';
import type { IssueJoinTokenResult } from '../application/issue-join-token';
import { ACTION_REASONS } from '../domain/agent-action';
import {
  AGENT_UPGRADE_FAILURES,
  AGENT_UPGRADE_STATES,
  type AgentUpgradeRecord,
} from '../domain/agent-upgrade';
import { type NodeRecord, observedStatus } from '../domain/node';
import { MAX_NODE_PUBLIC_ADDRESSES } from '../domain/node-address';
import type { ReadoptionRequest } from '../domain/node-readoption';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class FleetOrganizationPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) organizationId!: string;
}
export class NodePathDto extends FleetOrganizationPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) nodeId!: string;
}
export class RemoveNodeDto {
  @ApiProperty({
    maxLength: 2048,
    description: 'Confirmation token for `node.remove` on this node (SPEC 3.6).',
  })
  @IsString()
  @Length(1, 2048)
  confirmation!: string;
}
export class SetNodePublicAddressesDto {
  @ApiProperty({
    type: [String],
    maxItems: MAX_NODE_PUBLIC_ADDRESSES,
    description:
      'The public IPv4 and IPv6 addresses of the node, replacing the current list. Each must be ' +
      'a bare, globally routable address; duplicates are merged and values stored canonical. An ' +
      'empty list clears them.',
  })
  @IsArray()
  @ArrayMaxSize(MAX_NODE_PUBLIC_ADDRESSES)
  // Lengths are the domain's check, so an oversized value is reported at its position.
  @IsString({ each: true })
  publicAddresses!: string[];
}
export class NodePageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Length(36, 36)
  @Matches(UUID)
  cursor?: string;
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 100;
}
export class JoinTokenIssuedDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    minLength: 43,
    maxLength: 43,
    description:
      'Single-use enrollment secret, shown once. Give it to the agent through its join token ' +
      'file, never on a command line.',
  })
  token!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({
    pattern: '^sha256:[0-9a-f]{64}$',
    description: 'Installation CA fingerprint the agent pins before sending the token.',
  })
  caFingerprint!: string;
  @ApiProperty({
    description:
      'host:port of the agent gateway, for the agent configuration (control_plane.address).',
  })
  gatewayAddress!: string;
}
export class NodeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['enrolling', 'ready', 'suspect', 'down', 'draining', 'removed'] })
  status!: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  labels!: Record<string, string>;
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'Sanitized host facts.' })
  facts!: Record<string, unknown>;
  @ApiProperty({
    type: [String],
    description: 'Public addresses declared by an administrator, canonical; empty until set.',
  })
  publicAddresses!: string[];
  @ApiProperty({ type: 'integer' }) leaseEpoch!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastHeartbeatAt!: string | null;
}
/** A certificate the gateway refused for this server, waiting for an administrator (#487). */
export class NodeReadoptionDto {
  @ApiProperty({ format: 'uuid' }) nodeId!: string;
  @ApiProperty({ description: 'Serial of the waiting certificate, lower-case hexadecimal.' })
  certificateSerial!: string;
  @ApiProperty({ format: 'date-time' }) certificateNotAfter!: string;
  @ApiProperty({ format: 'date-time', description: 'When the gateway first refused it.' })
  firstSeenAt!: string;
  @ApiProperty({
    format: 'date-time',
    description: 'When the gateway last refused it, refreshed at most once a minute.',
  })
  lastSeenAt!: string;
}
export class NodeReadoptionPageDto {
  @ApiProperty({ type: [NodeReadoptionDto] }) items!: NodeReadoptionDto[];
}
/** The proof to re-adopt a server, and the certificate the administrator reviewed (#545). */
export class ReadoptNodeDto extends ReauthenticateMfaDto {
  @ApiProperty({
    pattern: '^[0-9a-f]{32}$',
    description:
      'Serial of the certificate reviewed, as the list of servers to re-adopt gives it. When another certificate waits for this server, the answer is 409 `readoption_changed` and nothing is adopted.',
  })
  @IsString()
  @Matches(/^[0-9a-f]{32}$/)
  certificateSerial!: string;
}
export class NodeReadoptedDto {
  @ApiProperty() certificateSerial!: string;
  @ApiProperty({ format: 'date-time' }) certificateNotAfter!: string;
}
export function nodeReadoptionDto(request: ReadoptionRequest): NodeReadoptionDto {
  return {
    nodeId: request.nodeId,
    certificateSerial: request.serial,
    certificateNotAfter: request.notAfter.toISOString(),
    firstSeenAt: request.firstSeenAt.toISOString(),
    lastSeenAt: request.lastSeenAt.toISOString(),
  };
}
export class NodePageDto {
  @ApiProperty({ type: [NodeDto] }) items!: NodeDto[];
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) nextCursor!: string | null;
}

export function joinTokenIssuedDto(
  result: IssueJoinTokenResult,
  gatewayAddress: string,
): JoinTokenIssuedDto {
  return {
    id: result.id,
    token: result.value.expose(),
    expiresAt: result.expiresAt.toISOString(),
    caFingerprint: result.caFingerprint,
    gatewayAddress,
  };
}
export function nodeDto(node: NodeRecord, now = new Date()): NodeDto {
  return {
    id: node.id,
    name: node.name,
    // Missed heartbeats read as suspect or down until leases persist them (M4.5).
    status: observedStatus(node, now),
    labels: { ...node.labels },
    facts: { ...node.facts },
    publicAddresses: [...node.publicAddresses],
    leaseEpoch: node.leaseEpoch,
    createdAt: node.createdAt.toISOString(),
    lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
  };
}

export class StartAgentUpgradeDto {
  @ApiProperty({
    maxLength: 64,
    example: '0.2.0',
    description:
      "The version to upgrade agents to, as the overview gave it: the control plane's own. A " +
      'control plane that runs another version by now refuses the rollout.',
  })
  @IsString()
  @Length(5, 64)
  @Matches(/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/)
  version!: string;
}
export class AgentUpgradeFailureDto {
  @ApiProperty({ format: 'uuid', description: 'The server whose turn it was.' }) nodeId!: string;
  @ApiProperty({ enum: AGENT_UPGRADE_FAILURES }) reason!: string;
  @ApiProperty({
    type: String,
    enum: ACTION_REASONS,
    nullable: true,
    description: 'Why the agent refused or failed the upgrade, when `reason` is `action_failed`.',
  })
  actionReason!: string | null;
}
export class AgentUpgradeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'The version every listed server goes to.' }) version!: string;
  @ApiProperty({ enum: AGENT_UPGRADE_STATES }) state!: string;
  @ApiProperty({ type: [String], description: 'The servers, in the order of their turns.' })
  nodeIds!: string[];
  @ApiProperty({
    type: 'integer',
    description: 'Index of the server whose turn it is; the number of servers once all are done.',
  })
  position!: number;
  @ApiProperty({ type: AgentUpgradeFailureDto, nullable: true })
  failure!: AgentUpgradeFailureDto | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) completedAt!: string | null;
}
export class AgentUpgradeOverviewDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The control plane's version, which agents are upgraded to; null on a development build.",
  })
  version!: string | null;
  @ApiProperty({
    type: [String],
    description: 'The servers whose agent runs an older release: a rollout started now lists them.',
  })
  pending!: string[];
  @ApiProperty({ type: AgentUpgradeDto, nullable: true, description: 'The newest rollout.' })
  rollout!: AgentUpgradeDto | null;
}

export function agentUpgradeDto(upgrade: AgentUpgradeRecord): AgentUpgradeDto {
  return {
    id: upgrade.id,
    version: upgrade.version,
    state: upgrade.state,
    nodeIds: [...upgrade.nodeIds],
    position: upgrade.position,
    failure: upgrade.failure ? { ...upgrade.failure } : null,
    createdAt: upgrade.createdAt.toISOString(),
    updatedAt: upgrade.updatedAt.toISOString(),
    completedAt: upgrade.completedAt?.toISOString() ?? null,
  };
}
export function agentUpgradeOverviewDto(overview: AgentUpgradeOverview): AgentUpgradeOverviewDto {
  return {
    version: overview.version,
    pending: [...overview.pending],
    rollout: overview.rollout ? agentUpgradeDto(overview.rollout) : null,
  };
}
