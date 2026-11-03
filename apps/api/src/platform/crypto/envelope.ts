import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Envelope encryption primitives (SPEC section 9).
 *
 * Blob layout, version 1: `0x01 | nonce (12 bytes) | tag (16 bytes) | ciphertext`.
 * AES-256-GCM with a random nonce per message and the caller's associated data (AAD), so a
 * ciphertext cannot be replayed under another scope or column.
 */
export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION_1 = 0x01;
const HEADER_BYTES = 1 + NONCE_BYTES + TAG_BYTES;

export class DecryptionError extends Error {
  constructor(reason: string) {
    super(`decryption failed: ${reason}`);
    this.name = 'DecryptionError';
  }
}

/** Generates a fresh 256-bit key (a data-encryption key, DEK). */
export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function assertKey(key: Buffer, what = 'key'): void {
  if (key.length !== KEY_BYTES) {
    throw new RangeError(`${what} must be ${String(KEY_BYTES)} bytes, got ${String(key.length)}`);
  }
}

/** Encrypts plaintext under key with the given associated data. */
export function encrypt(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION_1]), nonce, cipher.getAuthTag(), ciphertext]);
}

/** Decrypts a blob produced by `encrypt`. Any tampering or key or AAD mismatch throws. */
export function decrypt(key: Buffer, blob: Buffer, aad: string): Buffer {
  assertKey(key);
  if (blob.length < HEADER_BYTES) {
    throw new DecryptionError('blob too short');
  }
  if (blob[0] !== VERSION_1) {
    throw new DecryptionError(`unsupported blob version ${String(blob[0])}`);
  }
  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  const tag = blob.subarray(1 + NONCE_BYTES, HEADER_BYTES);
  const ciphertext = blob.subarray(HEADER_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Node reports every GCM failure the same way; do not leak which part failed.
    throw new DecryptionError('authentication failed');
  }
}

/** AAD used when a DEK is wrapped by the KEK, binding the wrapped key to its scope. */
export function dataKeyAad(scope: string, kekVersion: number): string {
  return `shipkeep:dek:v${String(kekVersion)}:${scope}`;
}

/** Wraps a DEK under the KEK for storage. */
export function wrapDataKey(kek: Buffer, dek: Buffer, scope: string, kekVersion: number): Buffer {
  assertKey(dek, 'data key');
  return encrypt(kek, dek, dataKeyAad(scope, kekVersion));
}

/** Unwraps a stored DEK. */
export function unwrapDataKey(
  kek: Buffer,
  wrapped: Buffer,
  scope: string,
  kekVersion: number,
): Buffer {
  const dek = decrypt(kek, wrapped, dataKeyAad(scope, kekVersion));
  assertKey(dek, 'data key');
  return dek;
}

/** Constant-time buffer comparison. */
export function keysEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
