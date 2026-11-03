import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppConfig } from '../config/app-config';

import { MemoryDataKeyStore } from '../../testing/memory-stores';

import { DecryptionError } from './envelope';
import { EnvelopeService } from './envelope.service';

async function kekFile(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'shipkeep-env-')), 'kek');
  await writeFile(path, randomBytes(32), { mode: 0o400 });
  return path;
}

function configWith(kekPath: string): AppConfig {
  return { get: () => kekPath } as unknown as AppConfig;
}

describe('EnvelopeService', () => {
  const plaintext = Buffer.from('sk_live_fake_value');

  it('creates one data key per scope and round-trips values', async () => {
    const store = new MemoryDataKeyStore();
    const service = new EnvelopeService(configWith(await kekFile()), store);
    await service.onModuleInit();

    const a1 = await service.encryptFor('environment:env_a', 'secret:STRIPE_KEY', plaintext);
    const a2 = await service.encryptFor('environment:env_a', 'secret:OTHER', plaintext);
    const b = await service.encryptFor('environment:env_b', 'secret:STRIPE_KEY', plaintext);

    expect(store.keys.size).toBe(2);
    expect(store.inserts).toBe(2);
    expect(await service.decryptFor('environment:env_a', 'secret:STRIPE_KEY', a1)).toEqual(
      plaintext,
    );
    expect(await service.decryptFor('environment:env_a', 'secret:OTHER', a2)).toEqual(plaintext);
    expect(await service.decryptFor('environment:env_b', 'secret:STRIPE_KEY', b)).toEqual(
      plaintext,
    );
    // Stored keys are wrapped: the plaintext DEK never appears in the store.
    for (const key of store.keys.values()) {
      expect(key.wrappedKey.length).toBeGreaterThan(32);
      expect(key.kekVersion).toBe(1);
    }
  });

  it('binds ciphertexts to their scope and purpose', async () => {
    const service = new EnvelopeService(configWith(await kekFile()), new MemoryDataKeyStore());
    await service.onModuleInit();
    const blob = await service.encryptFor('environment:env_a', 'secret:A', plaintext);
    await expect(service.decryptFor('environment:env_a', 'secret:B', blob)).rejects.toThrow(
      DecryptionError,
    );
    await expect(service.decryptFor('environment:env_b', 'secret:A', blob)).rejects.toThrow(
      DecryptionError,
    );
  });

  it('cannot decrypt with another installation KEK', async () => {
    const store = new MemoryDataKeyStore();
    const first = new EnvelopeService(configWith(await kekFile()), store);
    await first.onModuleInit();
    const blob = await first.encryptFor('environment:env_a', 'secret:A', plaintext);

    const other = new EnvelopeService(configWith(await kekFile()), store);
    await other.onModuleInit();
    await expect(other.decryptFor('environment:env_a', 'secret:A', blob)).rejects.toThrow(
      DecryptionError,
    );
  });

  it('reuses a key another instance inserted concurrently', async () => {
    const store = new MemoryDataKeyStore();
    const kek = await kekFile();
    const one = new EnvelopeService(configWith(kek), store);
    const two = new EnvelopeService(configWith(kek), store);
    await one.onModuleInit();
    await two.onModuleInit();
    const blob = await one.encryptFor('environment:shared', 'secret:A', plaintext);
    expect(await two.decryptFor('environment:shared', 'secret:A', blob)).toEqual(plaintext);
    expect(store.keys.size).toBe(1);
  });

  it('refuses to work before the KEK is loaded', async () => {
    const service = new EnvelopeService(configWith(await kekFile()), new MemoryDataKeyStore());
    await expect(service.encryptFor('s', 'p', plaintext)).rejects.toThrow(/not loaded/);
  });
});
