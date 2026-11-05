import { ApiProperty, IntersectionType } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { SessionDto } from '../../identity/interface/identity.dto';
import { ReauthenticateMfaDto } from '../../identity/interface/mfa.dto';

import { OrganizationDto } from './resource.dto';

export class OrganizationSettingsDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 320,
    description: 'Trimmed to a display name of 1–80 Unicode code points.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  name!: string;
  @ApiProperty({ minLength: 1, maxLength: 40, pattern: '^[a-z][a-z0-9-]{0,39}$' })
  @IsString()
  @MaxLength(40)
  @Matches(/^[a-z][a-z0-9-]{0,39}$/)
  slug!: string;
}
export class CreateOrganizationDto extends IntersectionType(
  OrganizationSettingsDto,
  ReauthenticateMfaDto,
) {}
export class OrganizationCreatedDto {
  @ApiProperty({ type: OrganizationDto }) organization!: OrganizationDto;
  @ApiProperty({
    type: SessionDto,
    description: 'Updated account profile; rotated credentials are set only in cookies.',
  })
  session!: SessionDto;
}
