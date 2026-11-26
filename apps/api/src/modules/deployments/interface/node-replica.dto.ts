import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

import { OrganizationPathDto } from '../../organizations/interface/resource.dto';
import { type NodeReplica, OBSERVED_STATES, STOP_REASONS } from '../domain/observations';
import type { UntrackedContainer } from '../domain/untracked-containers';

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

/** A container the server runs that no placed replica matches, of a known application (#501). */
export class UntrackedContainerDto {
  @ApiProperty({ description: 'The container name, as the server reports it.' }) name!: string;
  @ApiProperty({ description: 'The full Docker container id.' }) containerId!: string;
  @ApiProperty({ enum: OBSERVED_STATES.filter((state) => state !== 'missing') }) state!: string;
  @ApiProperty({
    format: 'date-time',
    description: "Since when the server's reports hold this set of unmatched containers.",
  })
  observedAt!: string;
  @ApiProperty({ type: NamedRefDto }) application!: NamedRefDto;
  @ApiProperty({ format: 'uuid' }) projectId!: string;
  @ApiProperty({ format: 'uuid' }) environmentId!: string;
  @ApiProperty({ type: 'integer', description: 'The release number its name carries.' })
  release!: number;
  @ApiProperty({
    type: String,
    description: 'The replica index its name carries, or `task` for a release task.',
  })
  replica!: string;
}
export class UntrackedContainerListDto {
  @ApiProperty({ type: [UntrackedContainerDto] }) items!: UntrackedContainerDto[];
}
export class UntrackedContainerPathDto extends NodeReplicaPathDto {
  @ApiProperty({ description: 'The container name.' })
  @Length(4, 63)
  @Matches(/^sk-[a-z0-9-]{1,60}$/)
  name!: string;
}
export class RemoveUntrackedContainerDto {
  @ApiProperty({ description: 'A confirmation token for `node.container.remove` (SPEC 3.6).' })
  @IsString()
  @Length(1, 2048)
  confirmation!: string;
}
export class UntrackedRemovalDto {
  @ApiProperty({ format: 'uuid', description: 'The agent action that removes it.' })
  actionId!: string;
}
export function untrackedContainerDto(container: UntrackedContainer): UntrackedContainerDto {
  return {
    name: container.name,
    containerId: container.containerId,
    state: container.state,
    observedAt: container.observedAt.toISOString(),
    application: { id: container.application.id, name: container.application.name },
    projectId: container.application.projectId,
    environmentId: container.application.environmentId,
    release: container.release,
    replica: String(container.replica),
  };
}
