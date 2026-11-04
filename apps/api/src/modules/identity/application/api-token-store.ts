import type { ApiScope } from '@shipkeep/domain';

/** Internal record. HTTP serializers must never include tokenHash. */
export interface ApiTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly scopes: readonly ApiScope[];
  readonly securityVersion: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly lastUsedAt: Date | null;
}
export const API_TOKEN_STORE = Symbol('ApiTokenStore');
/** Mutations and their audit events run under IdentityStore.withUserLock. */
export interface ApiTokenStore {
  insert(record: ApiTokenRecord): Promise<void>;
  findByHash(hash: string): Promise<ApiTokenRecord | null>;
  findOwned(userId: string, id: string): Promise<ApiTokenRecord | null>;
  /** At most 100 records, newest UUID first; exclusive cursor needs no cross-owner lookup. */
  list(userId: string, beforeId?: string): Promise<ApiTokenRecord[]>;
  countActive(userId: string, securityVersion: number, now: Date): Promise<number>;
  revoke(userId: string, id: string, now: Date): Promise<boolean>;
  touch(id: string, now: Date): Promise<boolean>;
}
