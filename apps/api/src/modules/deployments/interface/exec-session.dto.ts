import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import type { ExecSession } from '../../fleet/application/exec-relay';
import { EXEC_ARG_BYTES, EXEC_ARGS, EXEC_MINUTES } from '../domain/exec-session';

/** What to run in which replica (SPEC 3.3). The domain checks the byte bounds again. */
export class OpenExecSessionDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 1000, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  replica?: number;

  @ApiPropertyOptional({
    type: [String],
    maxItems: EXEC_ARGS,
    default: ['sh'],
    description: 'The command and its arguments, an argument vector: never run through a shell.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EXEC_ARGS)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(EXEC_ARG_BYTES, { each: true })
  argv?: string[];

  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() tty?: boolean;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: EXEC_MINUTES.min,
    maximum: EXEC_MINUTES.max,
    default: EXEC_MINUTES.default,
    description: 'How long the session may last, in minutes.',
  })
  @IsOptional()
  @IsInt()
  @Min(EXEC_MINUTES.min)
  @Max(EXEC_MINUTES.max)
  minutes?: number;
}

export class ExecSessionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) nodeId!: string;
  @ApiProperty({ format: 'date-time', description: 'Until when the session can be joined.' })
  attachBy!: string;
  @ApiProperty({ format: 'date-time', description: 'When the session ends at the latest.' })
  endsAt!: string;
  @ApiProperty({ description: 'The WebSocket path that joins the session.' })
  websocketPath!: string;
}

export function execSessionDto(session: ExecSession): ExecSessionDto {
  return {
    id: session.id,
    nodeId: session.nodeId,
    attachBy: session.attachBy.toISOString(),
    endsAt: session.endsAt.toISOString(),
    websocketPath: `/api/v1/exec/${session.id}`,
  };
}
