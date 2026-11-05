export interface MfaRecord {
  readonly userId: string;
  readonly activeCiphertext: Uint8Array | null;
  readonly enabledAt: Date | null;
  readonly lastCounter: number | null;
  readonly pendingCiphertext: Uint8Array | null;
  readonly pendingVersion: number | null;
  readonly pendingCreatedAt: Date | null;
  readonly pendingExpiresAt: Date | null;
}

export const MFA_STORE = Symbol('MfaStore');
/** Ciphertext only. Commands must hold IdentityStore.withUserLock while mutating MFA state. */
export interface MfaStore {
  find(userId: string): Promise<MfaRecord | null>;
  stage(
    userId: string,
    ciphertext: Uint8Array,
    securityVersion: number,
    now: Date,
  ): Promise<boolean>;
  activate(userId: string, counter: number, now: Date): Promise<boolean>;
  claimCounter(userId: string, counter: number, now: Date): Promise<boolean>;
  replaceRecovery(userId: string, hashes: readonly string[], now: Date): Promise<void>;
  claimRecovery(userId: string, hash: string, now: Date): Promise<boolean>;
  remove(userId: string): Promise<void>;
}
