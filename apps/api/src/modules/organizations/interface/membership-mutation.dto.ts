import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import type { OrganizationRole } from '@shipkeep/domain';
import { IsIn, Length, Matches } from 'class-validator';

import { EmailDto, SessionDto } from '../../identity/interface/identity.dto';
import { ReauthenticateMfaDto } from '../../identity/interface/mfa.dto';

import { MembershipDto } from './administration.dto';
import { OrganizationPathDto } from './resource.dto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ROLES: readonly OrganizationRole[] = ['owner', 'admin', 'member'];

export class MembershipPathDto extends OrganizationPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) membershipId!: string;
}
export class OrganizationRoleDto {
  @ApiProperty({ enum: ROLES }) @IsIn(ROLES) role!: OrganizationRole;
}
export class AddMemberDto extends IntersectionType(
  EmailDto,
  OrganizationRoleDto,
  ReauthenticateMfaDto,
) {}
export class MemberRoleDto extends IntersectionType(OrganizationRoleDto, ReauthenticateMfaDto) {}
export class RemoveMemberDto extends ReauthenticateMfaDto {}

export class MembershipMutationDto {
  @ApiProperty({ type: MembershipDto, nullable: true, description: 'Null after removal.' })
  membership!: MembershipDto | null;
  @ApiPropertyOptional({
    type: SessionDto,
    description:
      "Present only when the caller changed their own role: the caller's credentials were " +
      'rotated and the new ones are set only in cookies.',
  })
  session?: SessionDto;
}
