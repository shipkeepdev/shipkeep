import { ApiProperty } from '@nestjs/swagger';
import type { OrganizationRole, ResourceRole } from '@shipkeep/domain';

import type { BindingView, MemberView } from '../application/administration-store';
import type { MembershipRecord } from '../application/membership-store';

import { PageDto, ResourceDto } from './resource.dto';

export class MembershipDto extends ResourceDto {
  @ApiProperty({ format: 'uuid' }) organizationId!: string;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ enum: ['owner', 'admin', 'member'] }) orgRole!: OrganizationRole;
}
export class MemberViewDto extends MembershipDto {
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty() active!: boolean;
}
export class BindingViewDto extends MemberViewDto {
  @ApiProperty({ enum: ['admin', 'developer', 'viewer'] }) role!: ResourceRole;
  @ApiProperty({ enum: ['organization', 'project', 'environment'] }) source!:
    'organization' | 'project' | 'environment';
  @ApiProperty({ enum: ['admin', 'developer', 'viewer'], nullable: true })
  directRole!: ResourceRole | null;
  @ApiProperty({ enum: ['admin', 'developer', 'viewer'], nullable: true })
  inheritedRole!: ResourceRole | null;
}
export class MemberPageDto extends PageDto {
  @ApiProperty({ type: [MemberViewDto] }) items!: MemberViewDto[];
}
export class BindingPageDto extends PageDto {
  @ApiProperty({ type: [BindingViewDto] }) items!: BindingViewDto[];
}

export function membershipDto(record: MembershipRecord): MembershipDto {
  return {
    id: record.id,
    organizationId: record.organizationId,
    userId: record.userId,
    orgRole: record.orgRole,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
export function memberViewDto(view: MemberView): MemberViewDto {
  return {
    id: view.id,
    organizationId: view.organizationId,
    userId: view.userId,
    orgRole: view.orgRole,
    email: view.email,
    active: view.active,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
  };
}
export function bindingViewDto(view: BindingView): BindingViewDto {
  return {
    id: view.id,
    organizationId: view.organizationId,
    userId: view.userId,
    orgRole: view.orgRole,
    email: view.email,
    active: view.active,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
    role: view.role,
    source: view.source,
    directRole: view.directRole,
    inheritedRole: view.inheritedRole,
  };
}
