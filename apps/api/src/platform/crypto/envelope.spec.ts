import {
  DecryptionError,
  decrypt,
  encrypt,
  generateKey,
  KEY_BYTES,
  unwrapDataKey,
  wrapDataKey,
} from './envelope';

const aad = 'secret:env_1:DATABASE_URL';

describe('envelope primitives', () => {
  const key = generateKey();
  const plaintext = Buffer.from('postgresql://user:hunter2@db/app', 'utf8');

  it('round-trips plaintext', () => {
    const blob = encrypt(key, plaintext, aad);
    expect(blob.length).toBe(1 + 12 + 16 + plaintext.length);
    expect(blob.includes(plaintext)).toBe(false);
    expect(decrypt(key, blob, aad)).toEqual(plaintext);
  });

  it('round-trips empty plaintext', () => {
    const blob = encrypt(key, Buffer.alloc(0), aad);
    expect(decrypt(key, blob, aad)).toEqual(Buffer.alloc(0));
  });

  it('uses a fresh nonce for every message', () => {
    const a = encrypt(key, plaintext, aad);
    const b = encrypt(key, plaintext, aad);
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
  });

  it.each([
    ['version byte', 0],
    ['nonce', 5],
    ['tag', 20],
    ['ciphertext', 1 + 12 + 16 + 3],
  ])('detects a flipped bit in the %s', (_region, offset) => {
    const blob = encrypt(key, plaintext, aad);
    const tampered = Buffer.from(blob);
    tampered[offset] = (tampered[offset] ?? 0) ^ 0x01;
    expect(() => decrypt(key, tampered, aad)).toThrow(DecryptionError);
  });

  it('detects truncation and appended bytes', () => {
    const blob = encrypt(key, plaintext, aad);
    expect(() => decrypt(key, blob.subarray(0, blob.length - 1), aad)).toThrow(DecryptionError);
    expect(() => decrypt(key, Buffer.concat([blob, Buffer.from([0])]), aad)).toThrow(
      DecryptionError,
    );
    expect(() => decrypt(key, Buffer.alloc(10), aad)).toThrow(/too short/);
  });

  it('rejects the wrong key and the wrong associated data', () => {
    const blob = encrypt(key, plaintext, aad);
    expect(() => decrypt(generateKey(), blob, aad)).toThrow(DecryptionError);
    expect(() => decrypt(key, blob, 'secret:env_2:DATABASE_URL')).toThrow(DecryptionError);
  });

  it('rejects keys of the wrong size', () => {
    expect(() => encrypt(Buffer.alloc(16), plaintext, aad)).toThrow(RangeError);
    expect(() => decrypt(Buffer.alloc(KEY_BYTES + 1), Buffer.alloc(40), aad)).toThrow(RangeError);
  });

  it('never mentions the plaintext or key in errors', () => {
    const blob = encrypt(key, plaintext, aad);
    try {
      decrypt(generateKey(), blob, aad);
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain(key.toString('hex'));
    }
  });
});

describe('data key wrapping', () => {
  const kek = generateKey();
  const dek = generateKey();

  it('round-trips a data key bound to its scope and KEK version', () => {
    const wrapped = wrapDataKey(kek, dek, 'environment:env_1', 1);
    expect(unwrapDataKey(kek, wrapped, 'environment:env_1', 1)).toEqual(dek);
    expect(() => unwrapDataKey(kek, wrapped, 'environment:env_2', 1)).toThrow(DecryptionError);
    expect(() => unwrapDataKey(kek, wrapped, 'environment:env_1', 2)).toThrow(DecryptionError);
    expect(() => unwrapDataKey(generateKey(), wrapped, 'environment:env_1', 1)).toThrow(
      DecryptionError,
    );
  });

  it('refuses to wrap a key of the wrong size', () => {
    expect(() => wrapDataKey(kek, Buffer.alloc(8), 'scope', 1)).toThrow(RangeError);
  });
});
