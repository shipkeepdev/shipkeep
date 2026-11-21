import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { TOKEN_PATTERN } from '../domain/identity-policy';

export class EmailDto {
  @ApiProperty({ maxLength: 254, format: 'email', example: 'person@example.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
export class CredentialsDto extends EmailDto {
  @ApiProperty({ minLength: 15, maxLength: 128, writeOnly: true, format: 'password' })
  @IsString()
  @MinLength(15)
  @MaxLength(128)
  password!: string;
}
export class RegisterDto extends CredentialsDto {
  @ApiProperty({
    required: false,
    maxLength: 256,
    description: 'The name to show instead of the address. Trimmed, at most 64 characters.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  name?: string;
}
export class EmailCodeDto {
  @ApiProperty({ minLength: 43, maxLength: 43, writeOnly: true })
  @IsString()
  @Matches(TOKEN_PATTERN)
  token!: string;
}
export class VerifyEmailDto extends EmailCodeDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 128,
    writeOnly: true,
    format: 'password',
    description: 'The password chosen at registration.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
export class ResetPasswordDto extends EmailCodeDto {
  @ApiProperty({ minLength: 15, maxLength: 128, writeOnly: true, format: 'password' })
  @IsString()
  @MinLength(15)
  @MaxLength(128)
  password!: string;
}
export class AuthOptionsDto {
  @ApiProperty({
    description:
      'Whether this installation sends email. Without it nobody signs up or asks for a reset link: its administrator creates accounts and resets passwords on the server (ADR 0020).',
  })
  email!: boolean;
}
export class SessionDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;
  @ApiProperty({ format: 'email' })
  email!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The name the account shows instead of its address; null when it has none.',
  })
  displayName!: string | null;
  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}

/** The session a response returns, from a grant or the request's principal. */
export function sessionDto(session: {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly expiresAt: Date;
}): SessionDto {
  return {
    userId: session.userId,
    email: session.email,
    displayName: session.displayName,
    expiresAt: session.expiresAt.toISOString(),
  };
}

export class DisplayNameDto {
  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 256,
    description: 'The name to show; empty or null removes it. Trimmed, at most 64 characters.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== null)
  @IsString()
  @MaxLength(256)
  displayName!: string | null;
}
