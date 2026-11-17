import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConflictError, Secret } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { EnvelopeService } from '../../../platform/crypto/envelope.service';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { RegistryCredentialStore } from '../application/ports';
import {
  MAX_REGISTRIES,
  type RegistryCredentialMetadata,
  type RegistryLogin,
} from '../domain/registry-credential';

/**
 * Passwords are encrypted with the organization's data key and bound to the registry and the
 * version, so a row copied to another registry or organization cannot be decrypted there (SPEC 9).
 */
@Injectable()
export class PrismaRegistryCredentialStore implements RegistryCredentialStore {
  constructor(
    private readonly database: PrismaUnitOfWork,
    private readonly envelope: EnvelopeService,
  ) {}

  async put(
    organizationId: string,
    login: { server: string; username: string; password: Secret },
    actorId: string,
    now: Date,
  ): Promise<RegistryCredentialMetadata> {
    const existing = await this.database.client.registryCredential.findFirst({
      where: { organizationId, server: login.server },
    });
    const version = (existing?.version ?? 0) + 1;
    const passwordEnc = new Uint8Array(
      await this.envelope.encryptFor(
        scope(organizationId),
        purpose(login.server, version),
        Buffer.from(login.password.expose(), 'utf8'),
      ),
    );
    if (existing) {
      // Compare-and-swap on the version: two concurrent writers cannot both win.
      const updated = await this.database.client.registryCredential.updateMany({
        where: { id: existing.id, organizationId, version: existing.version },
        data: {
          username: login.username,
          passwordEnc,
          version,
          updatedBy: actorId,
          updatedAt: now,
        },
      });
      if (updated.count !== 1) throw changed();
      return metadata({
        ...existing,
        username: login.username,
        version,
        updatedBy: actorId,
        updatedAt: now,
      });
    }
    // One more registry: counted under a lock, so that the list never holds more than it returns.
    await this.lock(organizationId);
    const stored = await this.database.client.registryCredential.count({
      where: { organizationId },
    });
    if (stored >= MAX_REGISTRIES)
      throw new ConflictError(
        'registry_limit_reached',
        `An organization stores credentials for at most ${String(MAX_REGISTRIES)} registries; remove one first.`,
      );
    const id = uuidv7();
    const inserted = await this.database.client.registryCredential.createMany({
      data: {
        id,
        organizationId,
        server: login.server,
        username: login.username,
        passwordEnc,
        version,
        updatedBy: actorId,
        createdAt: now,
        updatedAt: now,
      },
      skipDuplicates: true,
    });
    if (inserted.count !== 1) throw changed();
    return {
      id,
      server: login.server,
      username: login.username,
      version,
      updatedBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Serializes additions for one organization until the transaction ends. */
  private async lock(organizationId: string): Promise<void> {
    await this.database.client
      .$queryRaw`SELECT pg_advisory_xact_lock(${lockKey(organizationId)})::text`;
  }

  async remove(
    organizationId: string,
    id: string,
  ): Promise<RegistryCredentialMetadata | undefined> {
    const existing = await this.database.client.registryCredential.findFirst({
      where: { organizationId, id },
    });
    if (!existing) return undefined;
    // Only the version that was read: a concurrent removal or replacement wins, and is the one
    // that gets audited.
    const deleted = await this.database.client.registryCredential.deleteMany({
      where: { organizationId, id: existing.id, version: existing.version },
    });
    if (deleted.count !== 1) throw changed();
    return metadata(existing);
  }

  async list(organizationId: string): Promise<RegistryCredentialMetadata[]> {
    const rows = await this.database.client.registryCredential.findMany({
      where: { organizationId },
      orderBy: { server: 'asc' },
      select: {
        id: true,
        server: true,
        username: true,
        version: true,
        updatedBy: true,
        createdAt: true,
        updatedAt: true,
      },
      take: MAX_REGISTRIES,
    });
    return rows.map(metadata);
  }

  async login(organizationId: string, server: string): Promise<RegistryLogin | undefined> {
    const row = await this.database.client.registryCredential.findFirst({
      where: { organizationId, server },
    });
    if (!row) return undefined;
    const password = await this.envelope.decryptFor(
      scope(organizationId),
      purpose(row.server, row.version),
      Buffer.from(row.passwordEnc),
    );
    return {
      server: row.server,
      username: row.username,
      password: new Secret(password.toString('utf8')),
    };
  }
}

function metadata(row: {
  id: string;
  server: string;
  username: string;
  version: number;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): RegistryCredentialMetadata {
  return {
    id: row.id,
    server: row.server,
    username: row.username,
    version: row.version,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
/** A transaction-level advisory lock; a hash collision only makes two organizations wait. */
function lockKey(organizationId: string): bigint {
  const hash = createHash('sha256').update(`shipkeep:registries:${organizationId}`).digest('hex');
  return BigInt.asIntN(64, BigInt(`0x${hash.slice(0, 16)}`));
}

function changed(): ConflictError {
  return new ConflictError(
    'registry_credentials_changed',
    'The credentials changed meanwhile; retry.',
  );
}
function scope(organizationId: string): string {
  return `organization:${organizationId}`;
}
function purpose(server: string, version: number): string {
  return `registry:${server}:${String(version)}`;
}
