import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

import type { SecretMetadata } from '../domain/secret-policy';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class SecretEnvironmentPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) organizationId!: string;
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) projectId!: string;
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) environmentId!: string;
}
export class SecretPathDto extends SecretEnvironmentPathDto {
  @ApiProperty({ pattern: '^[A-Z_][A-Z0-9_]{0,127}$' })
  @Matches(/^[A-Z_][A-Z0-9_]{0,127}$/)
  name!: string;
}
export class SetSecretDto {
  @ApiProperty({ pattern: '^[A-Z_][A-Z0-9_]{0,127}$' })
  @Matches(/^[A-Z_][A-Z0-9_]{0,127}$/)
  name!: string;
  @ApiProperty({ minLength: 1, maxLength: 65536, writeOnly: true, description: 'Never returned.' })
  @IsString()
  @Length(1, 65536)
  value!: string;
}
export class SecretDto {
  @ApiProperty() name!: string;
  @ApiProperty({ type: 'integer' }) version!: number;
  @ApiProperty({ type: String, nullable: true, description: 'Account that set this version.' })
  updatedBy!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class SecretListDto {
  @ApiProperty({ type: [SecretDto] }) items!: SecretDto[];
}

export function secretDto(metadata: SecretMetadata): SecretDto {
  return {
    name: metadata.name,
    version: metadata.version,
    updatedBy: metadata.updatedBy,
    createdAt: metadata.createdAt.toISOString(),
    updatedAt: metadata.updatedAt.toISOString(),
  };
}
