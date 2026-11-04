import type { Secret } from '@shipkeep/domain';

import type { IdentityTokenRecord, SessionRecord, UserRecord } from '../domain/identity-records';

export const IDENTITY_STORE = Symbol('IdentityStore');

/** Mutations and their events must be awaited inside transaction/withUserLock. */
export interface IdentityStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  withUserLock<T>(id: string, operation: (user: UserRecord) => Promise<T>): Promise<T>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUser(id: string): Promise<UserRecord | null>;
  insertUser(user: UserRecord): Promise<boolean>;
  activateUser(id: string, now: Date): Promise<void>;
  changePassword(id: string, hash: Secret, now: Date): Promise<void>;
  insertToken(token: IdentityTokenRecord): Promise<void>;
  findToken(hash: string): Promise<IdentityTokenRecord | null>;
  consumeToken(id: string, now: Date): Promise<boolean>;
  invalidateTokens(
    userId: string,
    purpose: IdentityTokenRecord['purpose'],
    now: Date,
  ): Promise<void>;
  insertSession(session: SessionRecord): Promise<void>;
  findSession(hash: string): Promise<{ session: SessionRecord; user: UserRecord } | null>;
  touchSession(id: string, now: Date): Promise<boolean>;
  revokeSession(userId: string, hash: string, now: Date): Promise<boolean>;
  revokeSessions(userId: string, now: Date): Promise<void>;
}
