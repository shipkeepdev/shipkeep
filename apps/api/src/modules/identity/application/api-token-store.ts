import type { ApiScope, ApiTokenProject } from '@shipkeep/domain';

/** Internal record. HTTP serializers must never include tokenHash. */
export interface ApiTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly scopes: readonly ApiScope[];
  /** Project-bound token (PLAN M2.3e): every scope and every use stays inside this project. */
  readonly project: ApiTokenProject | null;
  readonly securityVersion: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly lastUsedAt: Date | null;
}
/** A project token with its creator's current security version, for status reporting. */
export interface ProjectApiTokenRecord extends ApiTokenRecord {
  readonly creatorSecurityVersion: number;
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
  /** Tokens bound to `project`, any creator; at most 100, newest UUID first, exclusive cursor. */
  listProject(project: ApiTokenProject, beforeId?: string): Promise<ProjectApiTokenRecord[]>;
  findInProject(project: ApiTokenProject, id: string): Promise<ApiTokenRecord | null>;
  /** Run under the creator's account lock (see AccountMutationAuthority.reauthenticatedWith). */
  revokeInProject(project: ApiTokenProject, id: string, now: Date): Promise<boolean>;
}
