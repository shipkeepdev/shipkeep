import { Injectable } from '@nestjs/common';
import { ConflictError } from '@shipkeep/domain';

import { type Node, Prisma } from '../../../platform/prisma/generated/client';
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
    try {
      await this.createNode(node);
    } catch (error: unknown) {
      // Two enrollments racing for the same name: report the domain conflict, not a 500.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictError('node_name_taken', `a node named ${node.name} already exists`, {
          name: node.name,
        });
      throw error;
    }
  }

  private async createNode(node: NodeRecord): Promise<void> {
    await this.database.client.node.create({
      data: {
        id: node.id,
        organizationId: node.organizationId,
        name: node.name,
        status: node.status,
        labels: node.labels,
        facts: node.facts,
        publicAddresses: [...node.publicAddresses],
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
    return row ? nodeRecord(row) : undefined;
  }

  async findById(organizationId: string, id: string): Promise<NodeRecord | undefined> {
    const row = await this.database.client.node.findFirst({ where: { organizationId, id } });
    return row ? nodeRecord(row) : undefined;
  }

  async remove(organizationId: string, id: string, now: Date): Promise<boolean> {
    const result = await this.database.client.node.updateMany({
      where: { organizationId, id, status: { not: 'removed' } },
      data: { status: 'removed' },
    });
    if (result.count !== 1) return false;
    await this.database.client.nodeCertificate.updateMany({
      where: { organizationId, nodeId: id, revokedAt: null },
      data: { revokedAt: now },
    });
    return true;
  }

  async heartbeat(
    organizationId: string,
    id: string,
    expected: NodeStatus,
    next: NodeStatus,
    now: Date,
  ): Promise<boolean> {
    const result = await this.database.client.node.updateMany({
      where: { organizationId, id, status: expected },
      data: { status: next, lastHeartbeatAt: now },
    });
    return result.count === 1;
  }

  async updateFacts(organizationId: string, id: string, facts: NodeFacts): Promise<void> {
    await this.database.client.node.updateMany({
      where: { organizationId, id, status: { not: 'removed' } },
      data: { facts },
    });
  }

  async setPublicAddresses(
    organizationId: string,
    id: string,
    addresses: readonly string[],
  ): Promise<NodeRecord | undefined> {
    const result = await this.database.client.node.updateMany({
      where: { organizationId, id, status: { not: 'removed' } },
      data: { publicAddresses: [...addresses] },
    });
    return result.count === 1 ? this.findById(organizationId, id) : undefined;
  }

  async list(organizationId: string, beforeId?: string): Promise<NodeRecord[]> {
    const rows = await this.database.client.node.findMany({
      where: { organizationId, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 100,
    });
    return rows.map(nodeRecord);
  }

  async insertCertificate(certificate: NodeCertificateRecord): Promise<void> {
    await this.database.client.nodeCertificate.create({ data: certificate });
  }
}

function nodeRecord(row: Node): NodeRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    status: row.status as NodeStatus,
    labels: row.labels as Record<string, string>,
    facts: row.facts as NodeFacts,
    publicAddresses: row.publicAddresses,
    leaseEpoch: row.leaseEpoch,
    createdAt: row.createdAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
  };
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
