import { Injectable } from '@nestjs/common';
import { ConflictError } from '@shipkeep/domain';

import { Prisma } from '../../../platform/prisma/generated/client';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { NodeReadoptionStore } from '../application/ports';
import { ReadoptionChangedError, type ReadoptionRequest } from '../domain/node-readoption';

type Row = {
  organizationId: string;
  nodeId: string;
  serial: string;
  notBefore: Date;
  notAfter: Date;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

const request = (row: Row): ReadoptionRequest => ({
  organizationId: row.organizationId,
  nodeId: row.nodeId,
  serial: row.serial,
  notBefore: row.notBefore,
  notAfter: row.notAfter,
  firstSeenAt: row.firstSeenAt,
  lastSeenAt: row.lastSeenAt,
});

/** Run under `runTenant`: row security keeps every read and write inside the organization. */
@Injectable()
export class PrismaNodeReadoptionStore implements NodeReadoptionStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async find(organizationId: string, nodeId: string): Promise<ReadoptionRequest | undefined> {
    const row = await this.database.client.nodeReadoption.findUnique({
      where: { organizationId_nodeId: { organizationId, nodeId } },
    });
    return row ? request(row) : undefined;
  }

  async list(organizationId: string): Promise<ReadoptionRequest[]> {
    const rows = await this.database.client.nodeReadoption.findMany({
      where: { organizationId },
      orderBy: { firstSeenAt: 'asc' },
    });
    return rows.map(request);
  }

  async save(value: ReadoptionRequest): Promise<void> {
    const { organizationId, nodeId, ...fields } = value;
    await this.database.client.nodeReadoption.upsert({
      where: { organizationId_nodeId: { organizationId, nodeId } },
      create: value,
      update: fields,
    });
  }

  async adopt(value: ReadoptionRequest, certificateId: string, now: Date): Promise<string[]> {
    const { organizationId, nodeId } = value;
    // The request goes first, and only if it still names the certificate read (#545). The delete
    // holds its row until commit: a presentation of another certificate that came meanwhile is
    // either seen here, and nothing is adopted, or waits and records itself again afterwards.
    const claimed = await this.database.client.nodeReadoption.deleteMany({
      where: { organizationId, nodeId, serial: value.serial },
    });
    if (claimed.count !== 1) throw new ReadoptionChangedError();
    const current = await this.database.client.nodeCertificate.findMany({
      where: { organizationId, nodeId, revokedAt: null },
      select: { serial: true },
    });
    await this.database.client.nodeCertificate.updateMany({
      where: { organizationId, nodeId, revokedAt: null },
      data: { revokedAt: now },
    });
    try {
      await this.database.client.nodeCertificate.create({
        data: {
          id: certificateId,
          organizationId,
          nodeId,
          serial: value.serial,
          notBefore: value.notBefore,
          notAfter: value.notAfter,
          revokedAt: null,
        },
      });
    } catch (error: unknown) {
      // The serial is registered already: the whole confirmation rolls back.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictError('readoption_conflict', 'this certificate is registered already');
      throw error;
    }
    return current.map((row) => row.serial);
  }
}
