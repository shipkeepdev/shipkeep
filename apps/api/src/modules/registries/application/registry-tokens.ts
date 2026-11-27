import { createHash, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { REGISTRY_TOKEN_KEY, type RegistryTokenKeyProvider } from '../../fleet/application/ports';
import {
  compactToken,
  grantedAccess,
  parseGrantUsername,
  requestedScopes,
  signingInput,
  tokenClaims,
  wellFormedPassword,
} from '../domain/registry-token';

import {
  REGISTRY_GRANT_STORE,
  REGISTRY_SERVICE,
  REGISTRY_TRANSACTION,
  type RegistryGrantStore,
  type RegistryTransaction,
} from './ports';

/** The answer Distribution's token authentication expects. */
export interface RegistryToken {
  readonly token: string;
  readonly expiresIn: number;
  readonly issuedAt: Date;
}

/** Any refusal: the answer never says whether the user, the password, or the deadline was wrong. */
export class RegistryTokenRefused extends Error {
  constructor() {
    super('registry token refused');
  }
}

/**
 * The registry's token endpoint (ADR 0030). A grant's user name and password, sent by the Docker
 * daemon or BuildKit, buy a token of five minutes for what was asked within the grant: its
 * application's repository, pull, and push when it allows it. Reads only; nothing is audited.
 */
@Injectable()
export class RegistryTokens {
  private readonly logger = new Logger(RegistryTokens.name);

  constructor(
    @Inject(REGISTRY_GRANT_STORE) private readonly store: RegistryGrantStore,
    @Inject(REGISTRY_TRANSACTION) private readonly transaction: RegistryTransaction,
    @Inject(REGISTRY_TOKEN_KEY) private readonly keys: RegistryTokenKeyProvider,
    @Inject(REGISTRY_SERVICE) private readonly service: string,
  ) {}

  async token(
    credentials: { username: string; password: string } | undefined,
    request: { service: string | undefined; scopes: readonly string[] },
    now = new Date(),
  ): Promise<RegistryToken> {
    const named = credentials ? parseGrantUsername(credentials.username) : undefined;
    if (
      !credentials ||
      !named ||
      !wellFormedPassword(credentials.password) ||
      (request.service !== undefined && request.service !== this.service)
    )
      throw new RegistryTokenRefused();
    const grant = await this.transaction.runTenant(named.organizationId, () =>
      this.store.find(named.organizationId, named.grantId),
    );
    const given = createHash('sha256').update(credentials.password, 'utf8').digest();
    if (
      !grant ||
      !timingSafeEqual(given, Buffer.from(grant.passwordSha256, 'hex')) ||
      grant.expiresAt.getTime() <= now.getTime()
    )
      throw new RegistryTokenRefused();
    const access = grantedAccess(grant, requestedScopes(request.scopes));
    const key = await this.keys.registryKey();
    const claims = tokenClaims({
      service: this.service,
      subject: credentials.username,
      access,
      id: uuidv7(),
      now,
      grantExpiresAt: grant.expiresAt,
    });
    const input = signingInput(key.keyId, claims);
    const signature = await this.keys.signRegistryToken(Buffer.from(input, 'utf8'));
    this.logger.debug({ grantId: grant.id, access: access.length }, 'registry token issued');
    return {
      token: compactToken(input, signature),
      expiresIn: claims.exp - claims.iat,
      issuedAt: now,
    };
  }
}
