import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length, Matches, MaxLength } from 'class-validator';

import { CONFIRMABLE_ACTIONS } from '../domain/confirmation-token';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ACTIONS = Object.keys(CONFIRMABLE_ACTIONS);

export class ConfirmationPathDto {
  @ApiProperty({ format: 'uuid' }) @Length(36, 36) @Matches(UUID) organizationId!: string;
}
export class RequestConfirmationDto {
  @ApiProperty({ enum: ACTIONS }) @IsIn(ACTIONS) action!: string;
  @ApiProperty({ maxLength: 128, pattern: '^[A-Za-z0-9._:/-]{1,128}$' })
  @Matches(/^[A-Za-z0-9._:/-]{1,128}$/)
  target!: string;
  @ApiProperty({
    minLength: 1,
    maxLength: 256,
    description: "The resource's exact current name, typed by the user.",
  })
  @IsString()
  @Length(1, 256)
  @MaxLength(256)
  name!: string;
}
export class ConfirmationIssuedDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    maxLength: 2048,
    description: 'Single-use EdDSA JWT (SPEC 3.6), valid five minutes. Shown once.',
  })
  token!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}
