import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import type { MetricsAnswer } from '../application/metrics-queries';
import type { Series } from '../application/ports';
import { RANGES } from '../domain/metrics';

export class MetricsRangeQueryDto {
  @ApiProperty({ required: false, enum: Object.keys(RANGES), default: '1h' })
  @IsOptional()
  @IsIn(Object.keys(RANGES))
  range?: keyof typeof RANGES;
}

export class OrganizationMetricsQueryDto {
  @ApiProperty({ required: false, enum: Object.keys(RANGES), default: '24h' })
  @IsOptional()
  @IsIn(Object.keys(RANGES))
  range?: keyof typeof RANGES;
}

export class MetricPointDto {
  @ApiProperty({ description: 'Unix time, in seconds.' }) t!: number;
  @ApiProperty() v!: number;
}
export class MetricSeriesDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Labels that tell series of one query apart, such as `status` for requests.',
  })
  labels!: Record<string, string>;
  @ApiProperty({ type: [MetricPointDto] }) points!: MetricPointDto[];
}

class MetricsBaseDto {
  @ApiProperty({
    description: 'False when this installation keeps no metrics: every series is empty.',
  })
  kept!: boolean;
  @ApiProperty({ enum: Object.keys(RANGES) }) range!: string;
  @ApiProperty() stepSeconds!: number;
  @ApiProperty({ format: 'date-time' }) from!: string;
  @ApiProperty({ format: 'date-time' }) to!: string;
}

export class ApplicationMetricsDto extends MetricsBaseDto {
  @ApiProperty({ type: [MetricSeriesDto], description: 'CPU in use, in cores.' })
  cpu!: MetricSeriesDto[];
  @ApiProperty({ type: [MetricSeriesDto], description: 'Memory in use, in bytes.' })
  memory!: MetricSeriesDto[];
  @ApiProperty({
    type: [MetricSeriesDto],
    description: 'Requests per second, one series per `status` class: 2xx, 3xx, 4xx, 5xx, other.',
  })
  requests!: MetricSeriesDto[];
  @ApiProperty({ type: [MetricSeriesDto], description: 'Mean response time, in seconds.' })
  duration!: MetricSeriesDto[];
}

export class OrganizationMetricsDto extends MetricsBaseDto {
  @ApiProperty({
    type: [MetricSeriesDto],
    description:
      'Requests per second over the environments the caller may read, one series per `status` class.',
  })
  requests!: MetricSeriesDto[];
  @ApiProperty({ type: [MetricSeriesDto], description: 'Mean response time, in seconds.' })
  duration!: MetricSeriesDto[];
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Requests over the whole period, read at its end; null when no metrics are kept.',
  })
  totalRequests!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Mean response time over the whole period, in seconds; null without any request.',
  })
  meanSeconds!: number | null;
}

export class NodeMetricsDto extends MetricsBaseDto {
  @ApiProperty({ type: [MetricSeriesDto], description: 'CPU in use, in cores.' })
  cpu!: MetricSeriesDto[];
  @ApiProperty({ type: [MetricSeriesDto] }) memory!: MetricSeriesDto[];
  @ApiProperty({ type: [MetricSeriesDto] }) memoryTotal!: MetricSeriesDto[];
  @ApiProperty({ type: [MetricSeriesDto], description: "Under Docker's data root, in bytes." })
  disk!: MetricSeriesDto[];
  @ApiProperty({ type: [MetricSeriesDto] }) diskTotal!: MetricSeriesDto[];
  @ApiProperty({ type: [MetricSeriesDto], description: 'Bytes per second received.' })
  received!: MetricSeriesDto[];
  @ApiProperty({ type: [MetricSeriesDto], description: 'Bytes per second sent.' })
  sent!: MetricSeriesDto[];
}

export function metricsDto<K extends string>(
  answer: MetricsAnswer<K>,
): MetricsBaseDto & Record<K, MetricSeriesDto[]> {
  const series = Object.fromEntries(
    Object.entries<readonly Series[]>(answer.series).map(([name, list]) => [
      name,
      list.map((item) => ({
        labels: { ...item.labels },
        points: item.points.map(([t, v]) => ({ t, v })),
      })),
    ]),
  ) as Record<K, MetricSeriesDto[]>;
  return {
    kept: answer.kept,
    range: answer.range,
    stepSeconds: answer.stepSeconds,
    from: answer.from.toISOString(),
    to: answer.to.toISOString(),
    ...series,
  };
}
