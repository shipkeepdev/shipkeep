import { Injectable } from '@nestjs/common';

import { EnvelopeService } from '../../../platform/crypto/envelope.service';
import type { AgentAction } from '../../../platform/prisma/generated/client';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { AgentActionStore } from '../application/ports';
import type {
  AgentActionChange,
  AgentActionEntry,
  AgentActionRecord,
  AgentActionState,
} from '../domain/agent-action';

const UNFINISHED = ['queued', 'pending', 'running', 'compensating'];

/** Payloads are encrypted per organization and bound to the action id (SPEC 9). */
@Injectable()
export class PrismaAgentActionStore implements AgentActionStore {
  constructor(
    private readonly database: PrismaUnitOfWork,
    private readonly envelope: EnvelopeService,
  ) {}

  async insert(record: AgentActionRecord): Promise<boolean> {
    const { payload, result, ...columns } = record;
    const payloadEnc = await this.envelope.encryptFor(
      scope(record.organizationId),
      purpose(record.id),
      Buffer.from(payload),
    );
    const inserted = await this.database.client.agentAction.createMany({
      data: {
        ...columns,
        payloadEnc: new Uint8Array(payloadEnc),
        ...(result === null ? {} : { result: result }),
      },
      skipDuplicates: true,
    });
    return inserted.count === 1;
  }

  async findByKey(
    organizationId: string,
    nodeId: string,
    idempotencyKey: string,
  ): Promise<AgentActionRecord | undefined> {
    const row = await this.database.client.agentAction.findFirst({
      where: { organizationId, nodeId, idempotencyKey },
    });
    return row ? this.record(row) : undefined;
  }

  async deliverable(
    organizationId: string,
    nodeId: string,
    now: Date,
  ): Promise<AgentActionRecord[]> {
    const rows = await this.database.client.agentAction.findMany({
      where: { organizationId, nodeId, state: { in: UNFINISHED }, deadline: { gt: now } },
      orderBy: { id: 'asc' },
      take: 100,
    });
    return Promise.all(rows.map((row) => this.record(row)));
  }

  async expire(organizationId: string, nodeId: string, now: Date): Promise<AgentActionRecord[]> {
    const rows = await this.database.client.agentAction.findMany({
      where: { organizationId, nodeId, state: { in: UNFINISHED }, deadline: { lte: now } },
      take: 100,
    });
    const expired: AgentActionRecord[] = [];
    for (const row of rows) {
      const updated = await this.database.client.agentAction.updateMany({
        where: { id: row.id, organizationId, state: { in: UNFINISHED } },
        data: { state: 'expired', updatedAt: now, completedAt: now },
      });
      if (updated.count === 1)
        expired.push({ ...(await this.record(row)), state: 'expired', completedAt: now });
    }
    return expired;
  }

  async apply(
    organizationId: string,
    nodeId: string,
    id: string,
    change: AgentActionChange,
  ): Promise<AgentActionRecord | undefined> {
    const terminal = !UNFINISHED.includes(change.state);
    const updated = await this.database.client.agentAction.updateMany({
      where: { id, organizationId, nodeId, state: { in: UNFINISHED } },
      data: {
        state: change.state,
        step: change.step,
        attempts: change.attempts,
        error: change.error,
        updatedAt: change.at,
        ...(change.result === null ? {} : { result: change.result }),
        ...(terminal ? { completedAt: change.at } : {}),
      },
    });
    if (updated.count !== 1) return undefined;
    const row = await this.database.client.agentAction.findFirst({
      where: { id, organizationId, nodeId },
    });
    return row ? this.record(row) : undefined;
  }

  async forApplication(
    organizationId: string,
    applicationId: string,
    beforeId: string | undefined,
    limit: number,
  ): Promise<AgentActionEntry[]> {
    // The encrypted payload is never selected, let alone decrypted, for a history read.
    const rows = await this.database.client.agentAction.findMany({
      where: { organizationId, applicationId, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: limit,
      select: {
        id: true,
        nodeId: true,
        kind: true,
        state: true,
        step: true,
        attempts: true,
        result: true,
        error: true,
        applicationId: true,
        deploymentId: true,
        createdAt: true,
        updatedAt: true,
        completedAt: true,
        node: { select: { name: true } },
      },
    });
    return rows.map(({ node, ...row }) => ({
      ...row,
      nodeName: node.name,
      state: row.state as AgentActionState,
      result: row.result ?? null,
    }));
  }

  private async record(row: AgentAction): Promise<AgentActionRecord> {
    const payload = await this.envelope.decryptFor(
      scope(row.organizationId),
      purpose(row.id),
      Buffer.from(row.payloadEnc),
    );
    const { payloadEnc: _encrypted, ...columns } = row;
    return {
      ...columns,
      payload: new Uint8Array(payload),
      state: row.state as AgentActionState,
      result: row.result ?? null,
    };
  }
}

function scope(organizationId: string): string {
  return `organization:${organizationId}`;
}
function purpose(id: string): string {
  return `agent_action:${id}`;
}
