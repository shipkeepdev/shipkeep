import { Injectable } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { JoinTokenStore, NodeStore } from '../application/ports';
import type { JoinTokenRecord } from '../domain/join-token';
import type { NodeCertificateRecord, NodeFacts, NodeRecord, NodeStatus } from '../domain/node';

import type {
  InstallationKeyKind,
  InstallationKeyStore,
  StoredInstallationKey,
} from './ca/installation-key-store';

@Injectable()
export class PrismaJoinTokenStore implements JoinTokenStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async insert(record: JoinTokenRecord): Promise<void> {
    await this.database.client.joinToken.create({ data: record });
  }

  async findByHash(tokenHash: string): Promise<JoinTokenRecord | undefined> {
    const row = await this.database.client.joinToken.findUnique({ where: { tokenHash } });
    return row ?? undefined;
  }

  async consume(id: string, nodeId: string, usedAt: Date): Promise<boolean> {
    // The `usedAt: null` condition makes the update atomic: only one caller can flip it.
    const result = await this.database.client.joinToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt, usedByNodeId: nodeId },
    });
    return result.count === 1;
  }
}

@Injectable()
export class PrismaNodeStore implements NodeStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async insert(node: NodeRecord): Promise<void> {
    await this.database.client.node.create({
      data: {
        id: node.id,
        organizationId: node.organizationId,
        name: node.name,
        status: node.status,
        labels: node.labels,
        facts: node.facts,
        leaseEpoch: node.leaseEpoch,
        createdAt: node.createdAt,
        lastHeartbeatAt: node.lastHeartbeatAt,
      },
    });
  }

  async findByName(organizationId: string, name: string): Promise<NodeRecord | undefined> {
    const row = await this.database.client.node.findUnique({
      where: { organizationId_name: { organizationId, name } },
    });
    if (!row) return undefined;
    return {
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      status: row.status as NodeStatus,
      labels: row.labels as Record<string, string>,
      facts: row.facts as NodeFacts,
      leaseEpoch: row.leaseEpoch,
      createdAt: row.createdAt,
      lastHeartbeatAt: row.lastHeartbeatAt,
    };
  }

  async insertCertificate(certificate: NodeCertificateRecord): Promise<void> {
    await this.database.client.nodeCertificate.create({ data: certificate });
  }
}

@Injectable()
export class PrismaInstallationKeyStore implements InstallationKeyStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async find(kind: InstallationKeyKind): Promise<StoredInstallationKey | undefined> {
    const row = await this.database.client.installationKey.findUnique({ where: { kind } });
    if (!row) return undefined;
    return {
      kind,
      certificatePem: row.certificatePem,
      publicKeyPem: row.publicKeyPem,
      privateKeyEnc: Buffer.from(row.privateKeyEnc),
      notAfter: row.notAfter,
      createdAt: row.createdAt,
    };
  }

  async insert(key: StoredInstallationKey & { id: string }): Promise<void> {
    await this.database.client.installationKey.create({
      data: {
        id: key.id,
        kind: key.kind,
        certificatePem: key.certificatePem,
        publicKeyPem: key.publicKeyPem,
        privateKeyEnc: new Uint8Array(key.privateKeyEnc),
        notAfter: key.notAfter,
        createdAt: key.createdAt,
      },
    });
  }
}
