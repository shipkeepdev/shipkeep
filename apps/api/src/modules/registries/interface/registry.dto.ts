import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

import type { RegistryCredentialMetadata } from '../domain/registry-credential';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class RegistryOrganizationPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) organizationId!: string;
}
export class RegistryPathDto extends RegistryOrganizationPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) registryId!: string;
}
export class SetRegistryCredentialsDto {
  @ApiProperty({
    maxLength: 255,
    example: 'ghcr.io',
    description:
      'Registry host and optional port, as image references name it. `docker.io` for Docker Hub.',
  })
  @IsString()
  @Length(1, 255)
  server!: string;
  @ApiProperty({ minLength: 1, maxLength: 256 })
  @IsString()
  @Length(1, 256)
  username!: string;
  @ApiProperty({
    minLength: 1,
    maxLength: 4096,
    writeOnly: true,
    description: 'Password or access token. Never returned.',
  })
  @IsString()
  @Length(1, 4096)
  password!: string;
}
export class RegistryCredentialsDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'ghcr.io' }) server!: string;
  @ApiProperty() username!: string;
  @ApiProperty({ type: 'integer', description: 'Incremented each time they are replaced.' })
  version!: number;
  @ApiProperty({ type: String, nullable: true, description: 'Account that set this version.' })
  updatedBy!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class RegistryCredentialsListDto {
  @ApiProperty({ type: [RegistryCredentialsDto] }) items!: RegistryCredentialsDto[];
}

export function registryCredentialsDto(
  metadata: RegistryCredentialMetadata,
): RegistryCredentialsDto {
  return {
    id: metadata.id,
    server: metadata.server,
    username: metadata.username,
    version: metadata.version,
    updatedBy: metadata.updatedBy,
    createdAt: metadata.createdAt.toISOString(),
    updatedAt: metadata.updatedAt.toISOString(),
  };
}
