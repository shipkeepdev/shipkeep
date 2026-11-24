import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import type { LogsAnswer } from '../application/logs-queries';
import { MAX_LOG_RESULTS, MAX_LOG_TEXT } from '../domain/logs';

export class LogsQueryDto {
  @ApiProperty({ required: false, maxLength: MAX_LOG_TEXT, description: 'Text the lines contain.' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_LOG_TEXT)
  text?: string;

  @ApiProperty({ required: false, enum: ['stdout', 'stderr'] })
  @IsOptional()
  @IsIn(['stdout', 'stderr'])
  stream?: 'stdout' | 'stderr';

  @ApiProperty({ required: false, type: 'integer', minimum: 1, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  instance?: number;

  @ApiProperty({ required: false, format: 'date-time', description: 'One hour ago by default.' })
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @ApiProperty({ required: false, format: 'date-time', description: 'Now by default.' })
  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;

  @ApiProperty({
    required: false,
    type: 'integer',
    minimum: 1,
    maximum: MAX_LOG_RESULTS,
    default: 200,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LOG_RESULTS)
  limit?: number;
}

export class LogLineDto {
  @ApiProperty({ format: 'date-time' }) time!: string;
  @ApiProperty({ enum: ['stdout', 'stderr'] }) stream!: 'stdout' | 'stderr';
  @ApiProperty({ type: 'integer', description: 'The replica.' }) instance!: number;
  @ApiProperty({ description: 'The line as the application wrote it, its secrets redacted.' })
  line!: string;
  @ApiProperty({ description: 'The line was longer than 16 KiB and was cut.' }) truncated!: boolean;
}

export class LogsDto {
  @ApiProperty({ description: 'False when this installation keeps no logs.' }) kept!: boolean;
  @ApiProperty({ type: [LogLineDto], description: 'Newest first.' }) lines!: LogLineDto[];
}

export function logsDto(answer: LogsAnswer): LogsDto {
  return { kept: answer.kept, lines: answer.lines.map((line) => ({ ...line })) };
}
