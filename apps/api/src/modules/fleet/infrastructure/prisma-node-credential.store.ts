import { Injectable } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { NodeCredentialStore } from '../application/ports';
import type { NodeCertificateRecord, NodeStatus } from '../domain/node';
import type { NodeCredential, NodeIdentity } from '../domain/node-identity';

@Injectable()
export class PrismaNodeCredentialStore implements NodeCredentialStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async find(serial: string): Promise<NodeCredential | undefined> {
    const row = await this.database.client.nodeCertificate.findUnique({
      where: { serial },
      include: { node: true },
    });
    if (!row) return undefined;
    return {
      serial: row.serial,
      nodeId: row.nodeId,
      organizationId: row.node.organizationId,
      status: row.node.status as NodeStatus,
      leaseEpoch: row.node.leaseEpoch,
      notBefore: row.notBefore,
      notAfter: row.notAfter,
      revokedAt: row.revokedAt,
    };
  }

  async replace(
    identity: NodeIdentity,
    certificate: NodeCertificateRecord,
    now: Date,
  ): Promise<boolean> {
    return this.database.run(async () => {
      const result = await this.database.client.nodeCertificate.updateMany({
        where: {
          serial: identity.serial,
          nodeId: identity.nodeId,
          revokedAt: null,
          notBefore: { lte: now },
          notAfter: { gt: now },
          node: { organizationId: identity.organizationId, status: { not: 'removed' } },
        },
        data: { revokedAt: now },
      });
      if (result.count !== 1) return false;
      await this.database.client.nodeCertificate.create({ data: certificate });
      return true;
    });
  }
}
