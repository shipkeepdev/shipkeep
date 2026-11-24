import { Injectable } from '@nestjs/common';

import type { AgentUpgrade } from '../../../platform/prisma/generated/client';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import { ACTION_REASONS, type ActionReason } from '../domain/agent-action';
import {
  AGENT_UPGRADE_FAILURES,
  AGENT_UPGRADE_STATES,
  type AgentUpgradeFailure,
  type AgentUpgradeRecord,
} from '../domain/agent-upgrade';
import type { AgentUpgradeChange, AgentUpgradeStore } from '../application/ports';

/** Rollouts of agent upgrades (ADR 0028); every method runs inside `runTenant`. */
@Injectable()
export class PrismaAgentUpgradeStore implements AgentUpgradeStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async insert(record: AgentUpgradeRecord): Promise<boolean> {
    // The partial unique index keeps one running rollout per organization.
    const inserted = await this.database.client.agentUpgrade.createMany({
      data: { ...columns(record), id: record.id, organizationId: record.organizationId },
      skipDuplicates: true,
    });
    return inserted.count === 1;
  }

  async findById(organizationId: string, id: string): Promise<AgentUpgradeRecord | undefined> {
    const row = await this.database.client.agentUpgrade.findFirst({
      where: { organizationId, id },
    });
    return row ? upgradeRecord(row) : undefined;
  }

  async latest(organizationId: string): Promise<AgentUpgradeRecord | undefined> {
    const row = await this.database.client.agentUpgrade.findFirst({
      where: { organizationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return row ? upgradeRecord(row) : undefined;
  }

  async findRunning(organizationId: string): Promise<AgentUpgradeRecord | undefined> {
    const row = await this.database.client.agentUpgrade.findFirst({
      where: { organizationId, state: 'running' },
    });
    return row ? upgradeRecord(row) : undefined;
  }

  async update(
    organizationId: string,
    id: string,
    expected: Pick<AgentUpgradeRecord, 'position' | 'actionId'>,
    change: AgentUpgradeChange,
  ): Promise<AgentUpgradeRecord | undefined> {
    const result = await this.database.client.agentUpgrade.updateMany({
      where: {
        organizationId,
        id,
        state: 'running',
        position: expected.position,
        actionId: expected.actionId,
      },
      data: {
        state: change.state,
        position: change.position,
        actionId: change.actionId,
        turnStartedAt: change.turnStartedAt,
        failureNodeId: change.failure?.nodeId ?? null,
        failureReason: change.failure?.reason ?? null,
        failureActionReason: change.failure?.actionReason ?? null,
        updatedAt: change.updatedAt,
        completedAt: change.completedAt,
      },
    });
    return result.count === 1 ? this.findById(organizationId, id) : undefined;
  }
}

function columns(record: AgentUpgradeRecord) {
  return {
    version: record.version,
    state: record.state,
    nodeIds: [...record.nodeIds],
    position: record.position,
    actionId: record.actionId,
    turnStartedAt: record.turnStartedAt,
    failureNodeId: record.failure?.nodeId ?? null,
    failureReason: record.failure?.reason ?? null,
    failureActionReason: record.failure?.actionReason ?? null,
    requestedBy: record.requestedBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
  };
}

function upgradeRecord(row: AgentUpgrade): AgentUpgradeRecord {
  const reason = AGENT_UPGRADE_FAILURES.find((known) => known === row.failureReason);
  return {
    id: row.id,
    organizationId: row.organizationId,
    version: row.version,
    state: AGENT_UPGRADE_STATES.find((known) => known === row.state) ?? 'failed',
    nodeIds: row.nodeIds,
    position: row.position,
    actionId: row.actionId,
    turnStartedAt: row.turnStartedAt,
    failure:
      row.failureNodeId && reason
        ? {
            nodeId: row.failureNodeId,
            reason: reason satisfies AgentUpgradeFailure,
            actionReason:
              ACTION_REASONS.find(
                (known): known is ActionReason => known === row.failureActionReason,
              ) ?? null,
          }
        : null,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}
