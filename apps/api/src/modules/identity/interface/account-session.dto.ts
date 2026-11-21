import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

import type { AccountSession } from '../application/account-session-commands';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class AccountSessionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'True for the session that made this request.' }) current!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Browser read from the session's User-Agent, among known names; null otherwise.",
  })
  browser!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "System read from the session's User-Agent, among known names; null otherwise.",
  })
  system!: string | null;
  @ApiProperty({ description: 'Address the session signed in from.' }) ip!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) lastSeenAt!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class AccountSessionListDto {
  @ApiProperty({ type: [AccountSessionDto] }) items!: AccountSessionDto[];
  @ApiProperty({
    description:
      'True when the account has more live sessions than the 100 most recently active listed.',
  })
  truncated!: boolean;
}

export class SessionsRevokedDto {
  @ApiProperty({ description: 'How many other sessions were ended.' }) revoked!: number;
}

export class AccountSessionIdDto {
  // Session ids are UUIDv7, which IsUUID refuses: the same lowercase pattern as token ids.
  @ApiProperty({ format: 'uuid' })
  @Matches(UUID)
  sessionId!: string;
}

export function accountSessionDto(session: AccountSession): AccountSessionDto {
  return {
    id: session.id,
    current: session.current,
    browser: session.device.browser,
    system: session.device.system,
    ip: session.ip,
    createdAt: session.createdAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  };
}
