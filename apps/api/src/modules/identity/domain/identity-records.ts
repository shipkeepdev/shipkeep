import type { Secret } from '@shipkeep/domain';

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: Secret;
  readonly status: 'pending' | 'active' | 'disabled';
  readonly emailVerifiedAt: Date | null;
  readonly securityVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IdentityTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly purpose: 'verify' | 'reset';
  readonly tokenHash: string;
  readonly securityVersion: number;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly csrfHash: string;
  readonly securityVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly ip: string;
  readonly userAgent: string;
}
