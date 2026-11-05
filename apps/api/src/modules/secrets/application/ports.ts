import type { Secret } from '@shipkeep/domain';

import type { SecretMetadata, SecretTarget } from '../domain/secret-policy';

export const SECRET_STORE = Symbol('SecretStore');
/** Every method runs inside `runTenant` for the target's organization. */
export interface SecretStore {
  /** Creates version 1 or stores the next version; the value is encrypted by the store. */
  put(
    target: SecretTarget,
    name: string,
    value: Secret,
    actorId: string,
    now: Date,
  ): Promise<SecretMetadata>;
  remove(target: SecretTarget, name: string): Promise<SecretMetadata | undefined>;
  list(target: SecretTarget): Promise<SecretMetadata[]>;
  /** Decrypted values for a deployment; missing names are omitted. */
  values(
    target: SecretTarget,
    names: readonly string[],
  ): Promise<{ name: string; version: number; value: Secret }[]>;
}

export const SECRET_TRANSACTION = Symbol('SecretTransaction');
export interface SecretTransaction {
  runTenant<T>(organizationId: string, work: () => Promise<T>): Promise<T>;
}
