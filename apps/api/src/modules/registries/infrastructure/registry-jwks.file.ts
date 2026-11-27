import { rename, writeFile } from 'node:fs/promises';

import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { REGISTRY_TOKEN_KEY, type RegistryTokenKeyProvider } from '../../fleet/application/ports';

import { REGISTRY_JWKS_FILE } from '../application/ports';

/**
 * Writes the public half of the registry's signing key where Distribution reads it at start
 * (`auth.token.jwks`, ADR 0030). The installation keys load first: their module is imported by
 * this one, and Nest runs an imported module's bootstrap hooks before the importer's. The file is
 * replaced in one rename, so the registry never reads half of it.
 */
@Injectable()
export class RegistryJwks implements OnApplicationBootstrap {
  private readonly logger = new Logger(RegistryJwks.name);

  constructor(
    @Inject(REGISTRY_TOKEN_KEY) private readonly keys: RegistryTokenKeyProvider,
    @Inject(REGISTRY_JWKS_FILE) private readonly file: string | undefined,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.file) return;
    const key = await this.keys.registryKey();
    const document = { keys: [{ ...key.jwk, kid: key.keyId, use: 'sig', alg: 'EdDSA' }] };
    const partial = `${this.file}.partial`;
    await writeFile(partial, `${JSON.stringify(document)}\n`, { mode: 0o644 });
    await rename(partial, this.file);
    this.logger.log({ keyId: key.keyId }, 'registry signing key published');
  }
}
