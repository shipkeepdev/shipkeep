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
export class ResetPasswordDto extends EmailCodeDto {
  @ApiProperty({ minLength: 15, maxLength: 128, writeOnly: true, format: 'password' })
  @IsString()
  @MinLength(15)
  @MaxLength(128)
  password!: string;
}
export class SessionDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;
  @ApiProperty({ format: 'email' })
  email!: string;
  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}
