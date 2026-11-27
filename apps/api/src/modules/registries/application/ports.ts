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

export const REGISTRY_TRANSACTION = Symbol('RegistryTransaction');
export interface RegistryTransaction {
  runTenant<T>(organizationId: string, work: () => Promise<T>): Promise<T>;
}

/** A credential for the installation's registry (ADR 0030), as stored: its password hashed. */
export interface RegistryGrant {
  readonly id: string;
  readonly organizationId: string;
  readonly applicationId: string;
  /** SHA-256 of the password, lower-case hex. */
  readonly passwordSha256: string;
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
