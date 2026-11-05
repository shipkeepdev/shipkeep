import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

import { OrganizationSettingsDto } from './organization-mutation.dto';

export class ProjectSettingsDto extends OrganizationSettingsDto {
  @ApiPropertyOptional({ enum: ['commit', 'pull_request'], default: 'pull_request' })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsIn(['commit', 'pull_request'])
  gitWriteMode?: 'commit' | 'pull_request';
}
export class EnvironmentSettingsDto {
  @ApiProperty({ minLength: 1, maxLength: 40, pattern: '^[a-z][a-z0-9-]{0,39}$' })
  @IsString()
  @MaxLength(40)
  @Matches(/^[a-z][a-z0-9-]{0,39}$/)
  name!: string;
  @ApiPropertyOptional({ enum: ['standard', 'preview'], default: 'standard' })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsIn(['standard', 'preview'])
  kind?: 'standard' | 'preview';
  @ApiPropertyOptional({ enum: ['none', 'restore-from-backup'], default: 'none' })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsIn(['none', 'restore-from-backup'])
  failoverPolicy?: 'none' | 'restore-from-backup';
  @ApiPropertyOptional({ default: true })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsBoolean()
  protected?: boolean;
}
