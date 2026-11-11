import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ACTION_KINDS } from '@shipkeep/proto-ts';
import { Type } from 'class-transformer';
import { IsInt, Length, Matches, Max, Min, ValidateIf } from 'class-validator';

import {
  ACTION_OUTCOMES,
  ACTION_REASONS,
  AGENT_ACTION_STATES,
  type AgentActionView,
} from '../../fleet/domain/agent-action';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RESULT_TYPES = ['container', 'image', 'health_check', 'release_task', 'transfer', 'facts'];

export class AgentActionPageQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Exclusive: the last id of the previous page.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Length(36, 36)
  @Matches(UUID)
  cursor?: string;
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

/** The validated fields of a typed result; logs, outputs and agent errors are never returned. */
export class AgentActionResultDto {
  @ApiProperty({ enum: RESULT_TYPES }) type!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Docker container id.' })
  containerId!: string | null;
  @ApiProperty({ type: String, nullable: true, pattern: '^sha256:[a-f0-9]{64}$' })
  imageDigest!: string | null;
  @ApiProperty({ type: Boolean, nullable: true }) healthy!: boolean | null;
  @ApiProperty({ type: 'integer', nullable: true, description: 'Release task exit code.' })
  exitCode!: number | null;
}

export class AgentActionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ACTION_KINDS, description: 'The typed action (SPEC 3.3).' }) kind!: string;
  @ApiProperty({ format: 'uuid' }) nodeId!: string;
  @ApiProperty() nodeName!: string;
  @ApiProperty({ enum: AGENT_ACTION_STATES }) state!: string;
  @ApiProperty({ description: 'Last step the agent reported; empty before it starts.' })
  step!: string;
  @ApiProperty({ type: 'integer' }) attempts!: number;
  @ApiProperty({
    enum: ACTION_OUTCOMES,
    description: '`refused`: the agent rejected the request before running anything.',
  })
  outcome!: string;
  @ApiProperty({ type: String, nullable: true, enum: ACTION_REASONS })
  reason!: string | null;
  @ApiProperty({ type: AgentActionResultDto, nullable: true })
  result!: AgentActionResultDto | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  deploymentId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) completedAt!: string | null;
}

export class AgentActionPageDto {
  @ApiProperty({ type: [AgentActionDto], description: 'Newest first.' }) items!: AgentActionDto[];
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Null on the last page.',
  })
  nextCursor!: string | null;
}

export function agentActionDto(action: AgentActionView): AgentActionDto {
  const { outcome, reason, result } = action.summary;
  return {
    id: action.id,
    kind: action.kind,
    nodeId: action.nodeId,
    nodeName: action.nodeName,
    state: action.state,
    step: action.step,
    attempts: action.attempts,
    outcome,
    reason,
    result: result && {
      type: result.type,
      containerId: result.type === 'container' ? result.containerId : null,
      imageDigest: result.type === 'image' ? result.imageDigest : null,
      healthy: result.type === 'health_check' ? result.healthy : null,
      exitCode: result.type === 'release_task' ? result.exitCode : null,
    },
    deploymentId: action.deploymentId,
    createdAt: action.createdAt.toISOString(),
    updatedAt: action.updatedAt.toISOString(),
    completedAt: action.completedAt?.toISOString() ?? null,
  };
}
