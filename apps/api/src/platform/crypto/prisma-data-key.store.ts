import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import type { DataKeyStore, StoredDataKey } from './data-key-store';

@Injectable()
export class PrismaDataKeyStore implements DataKeyStore {
  constructor(private readonly prisma: PrismaService) {}

  async find(scope: string): Promise<StoredDataKey | undefined> {
    const row = await this.prisma.dataEncryptionKey.findUnique({ where: { scope } });
    if (!row) return undefined;
    return {
      scope: row.scope,
      wrappedKey: Buffer.from(row.wrappedKey),
      kekVersion: row.kekVersion,
    };
  }

  async insert(key: StoredDataKey & { id: string }): Promise<void> {
    // The unique index on `scope` makes a concurrent insert fail, which EnvelopeService handles.
    await this.prisma.dataEncryptionKey.create({
      data: {
        id: key.id,
        scope: key.scope,
        // Prisma Bytes wants a Uint8Array backed by a plain ArrayBuffer.
        wrappedKey: new Uint8Array(key.wrappedKey),
        kekVersion: key.kekVersion,
      },
    });
  }
}
