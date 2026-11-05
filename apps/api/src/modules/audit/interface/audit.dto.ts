import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, Length, Matches, Max, Min, ValidateIf } from 'class-validator';

import type { AuditFilter } from '../application/audit-event-reader';
import type { AuditRecord } from '../domain/audit-record';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const optional = () => ValidateIf((_object: unknown, value: unknown) => value !== undefined);

export class AuditOrganizationPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) organizationId!: string;
}
export class AuditFilterDto {
  @ApiPropertyOptional({ pattern: '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$', maxLength: 128 })
  @optional()
  @Length(3, 128)
  @Matches(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
  action?: string;
  @ApiPropertyOptional({ pattern: '^[a-z][a-z0-9_]{0,63}$' })
  @optional()
  @Matches(/^[a-z][a-z0-9_]{0,63}$/)
  targetType?: string;
  @ApiPropertyOptional({ maxLength: 128, pattern: '^[A-Za-z0-9._:/-]{1,128}$' })
  @optional()
  @Matches(/^[A-Za-z0-9._:/-]{1,128}$/)
  targetId?: string;
  @ApiPropertyOptional({ maxLength: 128, pattern: '^[A-Za-z0-9._:/-]{1,128}$' })
  @optional()
  @Matches(/^[A-Za-z0-9._:/-]{1,128}$/)
  actorId?: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Inclusive lower bound.' })
  @optional()
  @IsISO8601({ strict: true, strictSeparator: true })
  from?: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Exclusive upper bound.' })
  @optional()
  @IsISO8601({ strict: true, strictSeparator: true })
  to?: string;
}
export class AuditPageQueryDto extends AuditFilterDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @optional()
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
export class AuditEventDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() action!: string;
  @ApiProperty({ enum: ['user', 'api_token', 'system', 'node'] }) actorKind!: string;
  @ApiProperty({ type: String, nullable: true }) actorId!: string | null;
  @ApiProperty({ type: String, nullable: true }) ip!: string | null;
  @ApiProperty() targetType!: string;
  @ApiProperty() targetId!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) metadata!: Record<string, unknown>;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class AuditEventPageDto {
  @ApiProperty({ type: [AuditEventDto] }) items!: AuditEventDto[];
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) nextCursor!: string | null;
}

export function auditFilter(query: AuditFilterDto): AuditFilter {
  return {
    ...(query.action ? { action: query.action } : {}),
    ...(query.targetType ? { targetType: query.targetType } : {}),
    ...(query.targetId ? { targetId: query.targetId } : {}),
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.from ? { from: new Date(query.from) } : {}),
    ...(query.to ? { to: new Date(query.to) } : {}),
  };
}
export function auditEventDto(record: AuditRecord): AuditEventDto {
  return {
    id: record.id,
    action: record.action,
    actorKind: record.actorKind,
    actorId: record.actorId,
    ip: record.ip,
    targetType: record.targetType,
    targetId: record.targetId,
    metadata: { ...record.metadata },
    createdAt: record.createdAt.toISOString(),
  };
}
