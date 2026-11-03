/** Stored form of a data-encryption key. */
export interface StoredDataKey {
  readonly scope: string;
  readonly wrappedKey: Buffer;
  readonly kekVersion: number;
}

/** Port for persisting wrapped DEKs. Keys are never updated in place; rotation inserts anew. */
export interface DataKeyStore {
  find(scope: string): Promise<StoredDataKey | undefined>;
  /** Inserts the key. Must fail when the scope already exists so two writers never race. */
  insert(key: StoredDataKey & { id: string }): Promise<void>;
}

export const DATA_KEY_STORE = Symbol('DataKeyStore');
