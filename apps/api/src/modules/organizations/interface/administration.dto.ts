import { ApiProperty } from '@nestjs/swagger';
import type { OrganizationRole, ResourceRole } from '@shipkeep/domain';

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
