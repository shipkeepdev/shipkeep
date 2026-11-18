import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

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
  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}
