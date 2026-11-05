import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import type { ResourceRole } from '@shipkeep/domain';
import { IsIn, Length, Matches } from 'class-validator';

import { EmailDto, SessionDto } from '../../identity/interface/identity.dto';
import { ReauthenticateMfaDto } from '../../identity/interface/mfa.dto';
import type { BindingRecord } from '../application/binding-store';

import { EnvironmentPathDto, ProjectPathDto, ResourceDto } from './resource.dto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ROLES: readonly ResourceRole[] = ['admin', 'developer', 'viewer'];

export class ProjectBindingPathDto extends ProjectPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) membershipId!: string;
}
export class EnvironmentBindingPathDto extends EnvironmentPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) membershipId!: string;
}
export class ResourceRoleDto {
  @ApiProperty({ enum: ROLES }) @IsIn(ROLES) role!: ResourceRole;
}
export class AssignBindingDto extends IntersectionType(
  EmailDto,
  ResourceRoleDto,
  ReauthenticateMfaDto,
) {}
export class RemoveBindingDto extends ReauthenticateMfaDto {}

export class BindingDto extends ResourceDto {
  @ApiProperty({ format: 'uuid' }) organizationId!: string;
  @ApiProperty({ format: 'uuid' }) projectId!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) environmentId!: string | null;
  @ApiProperty({ format: 'uuid' }) membershipId!: string;
  @ApiProperty({ enum: ROLES }) role!: ResourceRole;
}
export class BindingMutationDto {
  @ApiProperty({ type: BindingDto, nullable: true, description: 'Null after removal.' })
  binding!: BindingDto | null;
  @ApiPropertyOptional({
    type: SessionDto,
    description:
      "Present only when the caller changed their own binding: the caller's credentials were " +
      'rotated and the new ones are set only in cookies.',
  })
  session?: SessionDto;
}

export function bindingDto(record: BindingRecord): BindingDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    projectId: record.projectId,
    environmentId: record.environmentId,
    membershipId: record.membershipId,
    role: record.role,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
