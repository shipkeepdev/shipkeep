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
