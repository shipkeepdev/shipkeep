import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PERMISSIONS, type Permission } from '@shipkeep/domain';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { ReauthenticateMfaDto } from './mfa.dto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export class ApiScopeDto {
  @ApiProperty({ enum: PERMISSIONS }) @IsIn(PERMISSIONS) permission!: Permission;
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Matches(UUID)
  organizationId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Matches(UUID)
  projectId?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Matches(UUID)
  environmentId?: string;
}
export class CreateApiTokenDto extends ReauthenticateMfaDto {
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;
  @ApiProperty({ type: [ApiScopeDto], minItems: 1, maxItems: 32 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => ApiScopeDto)
  scopes!: ApiScopeDto[];
  @ApiProperty({ format: 'date-time', description: 'One minute to ninety days from creation.' })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
  expiresAt!: string;
}
export class ApiTokenIdDto {
  @ApiProperty({ format: 'uuid' }) @Matches(UUID) id!: string;
}
export class ApiTokenPageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @Matches(UUID)
  cursor?: string;
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 100;
}
export class ApiTokenDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [ApiScopeDto] }) scopes!: ApiScopeDto[];
  @ApiProperty({ enum: ['active', 'revoked', 'expired', 'invalidated'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) revokedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastUsedAt!: string | null;
}
export class ApiTokenCreatedDto extends ApiTokenDto {
  @ApiProperty({
    description: 'Private credential shown on creation only. Store it securely.',
    minLength: 43,
    maxLength: 43,
  })
  token!: string;
}
export class ApiTokenPageDto {
  @ApiProperty({ type: [ApiTokenDto] }) items!: ApiTokenDto[];
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) nextCursor!: string | null;
}
