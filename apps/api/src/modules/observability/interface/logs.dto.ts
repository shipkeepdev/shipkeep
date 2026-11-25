import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import type { LogsAnswer } from '../application/logs-queries';
import { MAX_LOG_RESULTS, MAX_LOG_TEXT } from '../domain/logs';

/** A time the server cannot read in its own time zone. */
const WITH_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/;

export class LogsQueryDto {
  @ApiProperty({
    required: false,
    maxLength: MAX_LOG_TEXT,
    description: 'Text the lines contain, matched with its case.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_LOG_TEXT)
  text?: string;

  @ApiProperty({ required: false, enum: ['stdout', 'stderr'] })
  @IsOptional()
  @IsIn(['stdout', 'stderr'])
  stream?: 'stdout' | 'stderr';

  @ApiProperty({
    required: false,
    type: 'integer',
    minimum: 0,
    maximum: 999,
    description: 'The replica, numbered from 0.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999)
  instance?: number;

  @ApiProperty({
    required: false,
    format: 'date-time',
    description: 'One hour ago by default. With its offset (`Z` or `±hh:mm`).',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(WITH_OFFSET, { message: 'from must end with Z or an offset' })
  from?: string;

  @ApiProperty({
    required: false,
    format: 'date-time',
    description: 'Now by default. With its offset (`Z` or `±hh:mm`).',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(WITH_OFFSET, { message: 'to must end with Z or an offset' })
  to?: string;

  @ApiProperty({
    required: false,
    enum: ['newest', 'oldest'],
    description:
      '`newest` first by default. A live view reads `oldest` first from its last line, and again at once while an answer is full, so that no line is skipped.',
  })
  @IsOptional()
  @IsIn(['newest', 'oldest'])
  order?: 'newest' | 'oldest';

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
