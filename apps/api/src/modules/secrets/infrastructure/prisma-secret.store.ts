import { Injectable } from '@nestjs/common';
import { ConflictError, Secret } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { EnvelopeService } from '../../../platform/crypto/envelope.service';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { SecretStore } from '../application/ports';
import type { SecretMetadata, SecretTarget } from '../domain/secret-policy';

/** Values are encrypted with the environment's DEK and bound to name and version (SPEC 9). */
@Injectable()
export class PrismaSecretStore implements SecretStore {
  constructor(
    private readonly database: PrismaUnitOfWork,
    private readonly envelope: EnvelopeService,
  ) {}

  async put(
    target: SecretTarget,
    name: string,
    value: Secret,
    actorId: string,
    now: Date,
  ): Promise<SecretMetadata> {
    const existing = await this.database.client.secret.findFirst({ where: { ...target, name } });
    const version = (existing?.version ?? 0) + 1;
    const valueEnc = new Uint8Array(
      await this.envelope.encryptFor(
        scope(target),
        purpose(name, version),
        Buffer.from(value.expose(), 'utf8'),
      ),
    );
    if (existing) {
      // Compare-and-swap on the version: two concurrent writers cannot both win.
      const updated = await this.database.client.secret.updateMany({
        where: {
          id: existing.id,
          organizationId: target.organizationId,
          version: existing.version,
        },
        data: { valueEnc, version, updatedBy: actorId, updatedAt: now },
      });
      if (updated.count !== 1)
        throw new ConflictError('secret_changed', 'The secret changed meanwhile; retry.');
      return { name, version, updatedBy: actorId, createdAt: existing.createdAt, updatedAt: now };
    }
    const inserted = await this.database.client.secret.createMany({
      data: {
        id: uuidv7(),
        ...target,
        name,
        valueEnc,
        version,
        updatedBy: actorId,
        createdAt: now,
        updatedAt: now,
      },
      skipDuplicates: true,
    });
    if (inserted.count !== 1)
      throw new ConflictError('secret_changed', 'The secret changed meanwhile; retry.');
    return { name, version, updatedBy: actorId, createdAt: now, updatedAt: now };
  }

  async remove(target: SecretTarget, name: string): Promise<SecretMetadata | undefined> {
    const existing = await this.database.client.secret.findFirst({ where: { ...target, name } });
    if (!existing) return undefined;
    await this.database.client.secret.deleteMany({
      where: { id: existing.id, organizationId: target.organizationId },
    });
    return metadata(existing);
  }

  async list(target: SecretTarget): Promise<SecretMetadata[]> {
    const rows = await this.database.client.secret.findMany({
      where: target,
      orderBy: { name: 'asc' },
      select: { name: true, version: true, updatedBy: true, createdAt: true, updatedAt: true },
      take: 500,
    });
    return rows.map(metadata);
  }

  async values(
    target: SecretTarget,
    names: readonly string[],
  ): Promise<{ name: string; version: number; value: Secret }[]> {
    const rows = await this.database.client.secret.findMany({
      where: { ...target, name: { in: [...names] } },
    });
    return Promise.all(
      rows.map(async (row) => ({
        name: row.name,
        version: row.version,
        value: new Secret(
          (
            await this.envelope.decryptFor(
              scope(target),
              purpose(row.name, row.version),
              Buffer.from(row.valueEnc),
            )
          ).toString('utf8'),
        ),
      })),
    );
  }
}

function metadata(row: {
  name: string;
  version: number;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SecretMetadata {
  return {
    name: row.name,
    version: row.version,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function scope(target: SecretTarget): string {
  return `environment:${target.environmentId}`;
}
function purpose(name: string, version: number): string {
  return `secret:${name}:${String(version)}`;
}
