// In-memory stores for tests that must not reach PostgreSQL.
import type {
  InstallationKeyKind,
  InstallationKeyStore,
  StoredInstallationKey,
} from '../modules/fleet/infrastructure/ca/installation-key-store';
import type { DataKeyStore, StoredDataKey } from '../platform/crypto/data-key-store';

export class MemoryDataKeyStore implements DataKeyStore {
  readonly keys = new Map<string, StoredDataKey>();
  inserts = 0;

  find(scope: string): Promise<StoredDataKey | undefined> {
    return Promise.resolve(this.keys.get(scope));
  }

  insert(key: StoredDataKey & { id: string }): Promise<void> {
    this.inserts += 1;
    if (this.keys.has(key.scope)) return Promise.reject(new Error('unique violation'));
    this.keys.set(key.scope, key);
    return Promise.resolve();
  }
}

export class MemoryInstallationKeyStore implements InstallationKeyStore {
  readonly keys = new Map<InstallationKeyKind, StoredInstallationKey>();
  inserts = 0;

  find(kind: InstallationKeyKind): Promise<StoredInstallationKey | undefined> {
    return Promise.resolve(this.keys.get(kind));
  }

  insert(key: StoredInstallationKey & { id: string }): Promise<void> {
    this.inserts += 1;
    if (this.keys.has(key.kind)) return Promise.reject(new Error('unique violation'));
    this.keys.set(key.kind, key);
    return Promise.resolve();
  }
}
