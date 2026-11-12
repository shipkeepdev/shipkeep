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

import type { IssueJoinTokenResult } from '../application/issue-join-token';
import { type NodeRecord, observedStatus } from '../domain/node';
import { MAX_NODE_PUBLIC_ADDRESSES } from '../domain/node-address';

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
