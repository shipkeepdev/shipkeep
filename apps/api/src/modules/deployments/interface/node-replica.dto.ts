import { ApiProperty } from '@nestjs/swagger';
import { Length, Matches } from 'class-validator';

import { OrganizationPathDto } from '../../organizations/interface/resource.dto';
import { type NodeReplica, OBSERVED_STATES, STOP_REASONS } from '../domain/observations';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class NodeReplicaPathDto extends OrganizationPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) nodeId!: string;
}

export class NamedRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class NodeReplicaDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) releaseId!: string;
  @ApiProperty({ type: 'integer' }) replica!: number;
  @ApiProperty() container!: string;
  @ApiProperty({ type: 'integer', description: 'CPU reserved on the server, in millicores.' })
  cpuMillis!: number;
  @ApiProperty({ type: 'integer', description: 'Memory reserved on the server, in bytes.' })
  memoryBytes!: number;
  @ApiProperty({ format: 'date-time' }) placedAt!: string;
  @ApiProperty({ type: NamedRefDto }) application!: NamedRefDto;
  @ApiProperty({ type: NamedRefDto }) project!: NamedRefDto;
  @ApiProperty({ type: NamedRefDto }) environment!: NamedRefDto;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: OBSERVED_STATES,
    description: 'What the agent last saw; null until it has seen the container.',
  })
  state!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: STOP_REASONS,
    description: 'Why its agent stopped it itself (ADR 0022).',
  })
  stopReason!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) observedAt!: string | null;
}

export class NodeReplicaListDto {
  @ApiProperty({ type: [NodeReplicaDto], description: 'By application name, at most 200.' })
  items!: NodeReplicaDto[];
  @ApiProperty({ description: 'True when the server runs more replicas than listed.' })
  truncated!: boolean;
}

export function nodeReplicaDto(replica: NodeReplica): NodeReplicaDto {
  return {
    id: replica.id,
    releaseId: replica.releaseId,
    replica: replica.replica,
    container: replica.container,
    cpuMillis: replica.cpuMillis,
    memoryBytes: replica.memoryBytes,
    placedAt: replica.placedAt.toISOString(),
    application: { ...replica.application },
    project: { ...replica.project },
    environment: { ...replica.environment },
    state: replica.state,
    stopReason: replica.stopReason,
    observedAt: replica.observedAt?.toISOString() ?? null,
  };
}
