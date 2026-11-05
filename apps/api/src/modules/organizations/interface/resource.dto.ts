import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Length, Matches, Max, Min, ValidateIf } from 'class-validator';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export class OrganizationPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) organizationId!: string;
}
export class ProjectPathDto extends OrganizationPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) projectId!: string;
}
export class EnvironmentPathDto extends ProjectPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) environmentId!: string;
}
export class CatalogQueryDto {
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
export class ResourceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class OrganizationDto extends ResourceDto {
  @ApiProperty({ minLength: 1, maxLength: 80 }) name!: string;
  @ApiProperty({ minLength: 1, maxLength: 40 }) slug!: string;
}
export class ProjectDto extends OrganizationDto {
  @ApiProperty({ format: 'uuid' }) organizationId!: string;
  @ApiProperty({ enum: ['commit', 'pull_request'] }) gitWriteMode!: 'commit' | 'pull_request';
}
export class EnvironmentDto extends ResourceDto {
  @ApiProperty({ format: 'uuid' }) organizationId!: string;
  @ApiProperty({ format: 'uuid' }) projectId!: string;
  @ApiProperty({ minLength: 1, maxLength: 40 }) name!: string;
  @ApiProperty({ enum: ['standard', 'preview'] }) kind!: 'standard' | 'preview';
  @ApiProperty({ enum: ['none', 'restore-from-backup'] }) failoverPolicy!:
    'none' | 'restore-from-backup';
  @ApiProperty() protected!: boolean;
}
export class PageDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) nextCursor!: string | null;
}
export class OrganizationPageDto extends PageDto {
  @ApiProperty({ type: [OrganizationDto] }) items!: OrganizationDto[];
}
export class ProjectPageDto extends PageDto {
  @ApiProperty({ type: [ProjectDto] }) items!: ProjectDto[];
}
export class EnvironmentPageDto extends PageDto {
  @ApiProperty({ type: [EnvironmentDto] }) items!: EnvironmentDto[];
}

/**
 * Response mappers list every field explicitly: a column added to a table must never reach API
 * clients (sessions or bearer tokens) without being declared here and in the DTO.
 */
interface Timestamps {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
function timestamps(record: Timestamps): { createdAt: string; updatedAt: string } {
  return { createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString() };
}
export function organizationDto(
  record: Timestamps & { readonly id: string; readonly name: string; readonly slug: string },
): OrganizationDto {
  return { id: record.id, name: record.name, slug: record.slug, ...timestamps(record) };
}
export function projectDto(
  record: Timestamps & {
    readonly id: string;
    readonly organizationId: string;
    readonly name: string;
    readonly slug: string;
    readonly gitWriteMode: 'commit' | 'pull_request';
  },
): ProjectDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    name: record.name,
    slug: record.slug,
    gitWriteMode: record.gitWriteMode,
    ...timestamps(record),
  };
}
export function environmentDto(
  record: Timestamps & {
    readonly id: string;
    readonly organizationId: string;
    readonly projectId: string;
    readonly name: string;
    readonly kind: 'standard' | 'preview';
    readonly failoverPolicy: 'none' | 'restore-from-backup';
    readonly protected: boolean;
  },
): EnvironmentDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    projectId: record.projectId,
    name: record.name,
    kind: record.kind,
    failoverPolicy: record.failoverPolicy,
    protected: record.protected,
    ...timestamps(record),
  };
}
