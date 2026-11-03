import { readFile, stat } from 'node:fs/promises';

import { Secret } from '@shipkeep/domain';

import { KEY_BYTES } from './envelope';

/** Current version of the key-encryption key. Rotation (a later admin command) increments it. */
export const KEK_VERSION = 1;

export class KekError extends Error {
  constructor(message: string) {
    super(`key-encryption key: ${message}`);
    this.name = 'KekError';
  }
}

/**
 * Loads the KEK from its file (SPEC section 9: `/etc/shipkeep/kek`, mode 0400, owned by the
 * service user). The file holds either 32 raw bytes or their base64 encoding. Files readable by
 * the group or by others are refused, because a KEK leak exposes every secret.
 */
export async function loadKek(path: string): Promise<Secret<Buffer>> {
  let info;
  try {
    info = await stat(path);
  } catch (error: unknown) {
    throw new KekError(`cannot read ${path}: ${error instanceof Error ? error.message : 'error'}`);
  }
  if (!info.isFile()) {
    throw new KekError(`${path} is not a regular file`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new KekError(
      `${path} is readable by group or others; set its mode to 0400 (current ${(info.mode & 0o777).toString(8)})`,
    );
  }
  const raw = await readFile(path);
  const key = decodeKey(raw);
  if (!key) {
    throw new KekError(
      `${path} must contain ${String(KEY_BYTES)} raw bytes or their base64 encoding`,
    );
  }
  return new Secret(key);
}

function decodeKey(raw: Buffer): Buffer | undefined {
  if (raw.length === KEY_BYTES) {
    return Buffer.from(raw);
  }
  const text = raw.toString('utf8').trim();
  if (/^[A-Za-z0-9+/]{43}=$/.test(text) || /^[A-Za-z0-9_-]{43}$/.test(text)) {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length === KEY_BYTES) return decoded;
  }
  return undefined;
}
