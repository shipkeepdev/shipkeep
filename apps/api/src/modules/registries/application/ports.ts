import type { Secret } from '@shipkeep/domain';

import type { RegistryCredentialMetadata, RegistryLogin } from '../domain/registry-credential';

export const REGISTRY_CREDENTIAL_STORE = Symbol('RegistryCredentialStore');
/** Every method runs inside `runTenant` for the organization. */
export interface RegistryCredentialStore {
  /** Stores the credentials of a registry, replacing earlier ones; the store encrypts the password. */
  put(
    organizationId: string,
    login: { server: string; username: string; password: Secret },
    actorId: string,
    now: Date,
  ): Promise<RegistryCredentialMetadata>;
  remove(organizationId: string, id: string): Promise<RegistryCredentialMetadata | undefined>;
  list(organizationId: string): Promise<RegistryCredentialMetadata[]>;
  /** The decrypted credentials of one registry, for a deployment; undefined when none is stored. */
  login(organizationId: string, server: string): Promise<RegistryLogin | undefined>;
}

export const REGISTRY_STORAGE = Symbol('RegistryStorage');
/**
 * The installation's registry as the retention reads and prunes it (ADR 0030). Calls carry tokens
 * the control plane signs for itself. A registry that does not answer as expected throws.
 */
export interface RegistryStorage {
  /** Repository names in order, at most `limit` after `last`. */
  repositories(last: string | undefined, limit: number): Promise<string[]>;
  /**
   * Every tag of the repository; none when it has no tag left. Throws when it has more than
   * `MAX_REGISTRY_TAGS`: a partial list would leave out tags to keep.
   */
  tags(repository: string): Promise<string[]>;
  /**
   * Deletes one tag, and only it: the manifest stays while another tag names it, and the
   * registry's garbage collection removes it once none does. False when the tag was gone already.
   */
  deleteTag(repository: string, tag: string): Promise<boolean>;
}

/** The most tags the retention reads of one repository. */
export const MAX_REGISTRY_TAGS = 10_000;

export const REGISTRY_TRANSACTION = Symbol('RegistryTransaction');
export interface RegistryTransaction {
  runTenant<T>(organizationId: string, work: () => Promise<T>): Promise<T>;
}

/** A credential for the installation's registry (ADR 0030), as stored: its secret hashed. */
export interface RegistryGrant {
  readonly id: string;
  readonly organizationId: string;
  readonly applicationId: string;
  /** `grantSecretHash` of the secret, lower-case hex. */
  readonly secretSha256: string;
  readonly push: boolean;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export const REGISTRY_GRANT_STORE = Symbol('RegistryGrantStore');
/** Every method runs inside `runTenant` for the organization. */
export interface RegistryGrantStore {
  insert(grant: RegistryGrant): Promise<void>;
  find(organizationId: string, grantId: string): Promise<RegistryGrant | undefined>;
  /** Removes the organization's grants that expired before `before`; answers how many. */
  removeExpired(organizationId: string, before: Date): Promise<number>;
}

/** Where the registry's public key is written for Distribution to read (unset: nowhere). */
export const REGISTRY_JWKS_FILE = Symbol('RegistryJwksFile');
/** The control plane's public host, the registry's name: tokens are for that audience. */
export const REGISTRY_SERVICE = Symbol('RegistryService');
