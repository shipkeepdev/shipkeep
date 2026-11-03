import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { AppConfig } from '../config/app-config';

import { DATA_KEY_STORE, type DataKeyStore } from './data-key-store';
import { decrypt, encrypt, generateKey, unwrapDataKey, wrapDataKey } from './envelope';
import { KEK_VERSION, loadKek } from './kek';

/**
 * Envelope encryption service (SPEC section 9). One data-encryption key (DEK) per scope, wrapped
 * by the key-encryption key (KEK) loaded from disk at startup. Callers pass the scope (for
 * example `environment:<id>`) and a purpose string that becomes associated data, so a ciphertext
 * only decrypts in the place it was written for.
 */
@Injectable()
export class EnvelopeService implements OnModuleInit {
  private readonly logger = new Logger(EnvelopeService.name);
  private kek: Secret<Buffer> | undefined;
  private readonly dekCache = new Map<string, Secret<Buffer>>();

  constructor(
    private readonly config: AppConfig,
    @Inject(DATA_KEY_STORE) private readonly store: DataKeyStore,
  ) {}

  async onModuleInit(): Promise<void> {
    this.kek = await loadKek(this.config.get('SHIPKEEP_KEK_FILE'));
    this.logger.log({ kekVersion: KEK_VERSION }, 'key-encryption key loaded');
  }

  /** Encrypts plaintext for a scope and purpose. */
  async encryptFor(scope: string, purpose: string, plaintext: Buffer): Promise<Buffer> {
    const dek = await this.dataKey(scope);
    return encrypt(dek.expose(), plaintext, aad(scope, purpose));
  }

  /** Decrypts a blob written by `encryptFor` with the same scope and purpose. */
  async decryptFor(scope: string, purpose: string, blob: Buffer): Promise<Buffer> {
    const dek = await this.dataKey(scope);
    return decrypt(dek.expose(), blob, aad(scope, purpose));
  }

  private async dataKey(scope: string): Promise<Secret<Buffer>> {
    const cached = this.dekCache.get(scope);
    if (cached) return cached;

    const kek = this.requireKek();
    let stored = await this.store.find(scope);
    if (!stored) {
      const fresh = generateKey();
      try {
        await this.store.insert({
          id: uuidv7(),
          scope,
          wrappedKey: wrapDataKey(kek, fresh, scope, KEK_VERSION),
          kekVersion: KEK_VERSION,
        });
      } catch (error: unknown) {
        // Another instance may have created the key first: read it back before giving up.
        stored = await this.store.find(scope);
        if (!stored) throw error;
      }
      stored ??= await this.store.find(scope);
      if (!stored) throw new Error(`data key for ${scope} vanished after insert`);
    }
    if (stored.kekVersion !== KEK_VERSION) {
      throw new Error(
        `data key for ${scope} is wrapped with KEK version ${String(stored.kekVersion)}, expected ${String(KEK_VERSION)}; run the KEK rotation command`,
      );
    }
    const dek = new Secret(unwrapDataKey(kek, stored.wrappedKey, scope, stored.kekVersion));
    this.dekCache.set(scope, dek);
    return dek;
  }

  private requireKek(): Buffer {
    if (!this.kek) throw new Error('key-encryption key not loaded yet');
    return this.kek.expose();
  }
}

function aad(scope: string, purpose: string): string {
  return `shipkeep:data:${scope}:${purpose}`;
}
