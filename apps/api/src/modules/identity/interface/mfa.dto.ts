import { ApiProperty, ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Secret } from '@shipkeep/domain';
import { IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

import type { MfaProofInput } from '../application/mfa-crypto';

import { CredentialsDto, SessionDto } from './identity.dto';

export class FactorDto {
  @ApiPropertyOptional({ pattern: '^[0-9]{6}$', writeOnly: true })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^\d{6}$/)
  totp?: string;

  @ApiPropertyOptional({ pattern: '^[a-f0-9]{32}$', writeOnly: true })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^[a-f0-9]{32}$/)
  recovery?: string;
}
export class LoginCredentialsDto extends IntersectionType(CredentialsDto, FactorDto) {}

export class MfaPasswordDto {
  @ApiProperty({ minLength: 15, maxLength: 128, writeOnly: true, format: 'password' })
  @IsString()
  @MinLength(15)
  @MaxLength(128)
  password!: string;
}
export class EnableMfaDto extends MfaPasswordDto {
  @ApiProperty({ pattern: '^[0-9]{6}$', writeOnly: true })
  @IsString()
  @Matches(/^\d{6}$/)
  totp!: string;
}
export class ReauthenticateMfaDto extends IntersectionType(MfaPasswordDto, FactorDto) {}

export class MfaStatusDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) pendingExpiresAt!:
    string | null;
  @ApiProperty({ minimum: 0, maximum: 10 }) recoveryCodesRemaining!: number;
}
export class MfaSetupDto {
  @ApiProperty({ description: 'Private base32 seed. Store only in the authenticator.' })
  secret!: string;
  @ApiProperty({ description: 'Private otpauth provisioning data; never a navigation URL.' })
  provisioningUri!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}
export class MfaRecoveryDto extends SessionDto {
  @ApiProperty({
    type: [String],
    minItems: 10,
    maxItems: 10,
    description: 'Private single-use codes shown on creation only.',
  })
  recoveryCodes!: string[];
}

export function factorInput(body: FactorDto): MfaProofInput {
  return {
    ...(body.totp !== undefined ? { totp: new Secret(body.totp) } : {}),
    ...(body.recovery !== undefined ? { recovery: new Secret(body.recovery) } : {}),
  };
}
