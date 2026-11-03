/** Kinds of long-lived installation key pairs (SPEC sections 3.2 and 3.6). */
export type InstallationKeyKind = 'ca' | 'confirmation';

export interface StoredInstallationKey {
  readonly kind: InstallationKeyKind;
  /** PEM certificate for `ca`; absent for bare key pairs. */
  readonly certificatePem: string | null;
  readonly publicKeyPem: string;
  /** PKCS#8 private key, encrypted with EnvelopeService (scope `installation:keys`). */
  readonly privateKeyEnc: Buffer;
  readonly notAfter: Date | null;
  readonly createdAt: Date;
}

export interface InstallationKeyStore {
  find(kind: InstallationKeyKind): Promise<StoredInstallationKey | undefined>;
  /** Inserts the key. Must fail when the kind already exists so two instances never create two CAs. */
  insert(key: StoredInstallationKey & { id: string }): Promise<void>;
}

export const INSTALLATION_KEY_STORE = Symbol('InstallationKeyStore');
