import { ApiProperty } from '@nestjs/swagger';
import { IsObject, Length, Matches } from 'class-validator';

import type { Application } from '../domain/application';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class ApplicationEnvironmentPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) organizationId!: string;
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) projectId!: string;
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) environmentId!: string;
}
export class ApplicationPathDto extends ApplicationEnvironmentPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) applicationId!: string;
}

const CONFIG_DESCRIPTION =
  'The shipkeep.yml document as JSON (SPEC 2), validated against the schema. Only build.type image is accepted for now. Secrets are listed by name; values are set through the secrets API.';

export class CreateApplicationDto {
  @ApiProperty({ type: 'object', additionalProperties: true, description: CONFIG_DESCRIPTION })
  @IsObject()
  config!: Record<string, unknown>;
}
export class UpdateApplicationConfigDto extends CreateApplicationDto {
  @ApiProperty({ pattern: SHA256.source, description: 'configSha of the configuration edited.' })
  @Matches(SHA256)
  expectedConfigSha!: string;
}

export class ApplicationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['image'] }) source!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) config!: object;
  @ApiProperty({ pattern: SHA256.source }) configSha!: string;
  @ApiProperty({ type: String, nullable: true }) createdBy!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class ApplicationListDto {
  @ApiProperty({ type: [ApplicationDto] }) items!: ApplicationDto[];
}

export function applicationDto(application: Application): ApplicationDto {
  return {
    id: application.id,
    name: application.name,
    source: application.source,
    config: application.config,
    configSha: application.configSha,
    createdBy: application.createdBy,
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),
  };
}
