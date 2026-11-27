import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { ShipkeepConfig } from '@shipkeep/config-schema';
import { v7 as uuidv7 } from 'uuid';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import { actionReason } from '../../fleet/domain/agent-action';
import type { PipelineApplication, PipelineStore, StoredAllocation } from '../application/ports';
import type { StepOutcome, StepState } from '../domain/pipeline';
import {
  type NodeLoad,
  nodeLoads,
  type NodeView,
  type ReplacingRelease,
} from '../domain/placement';
import type { Release } from '../domain/release';

const STEP_STATES: readonly StepState[] = [
  'queued',
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'compensating',
  'compensated',
  'expired',
];
const DIGEST = /^sha256:[a-f0-9]{64}$/;
/** A deployment has a few steps per replica and node; anything more is not ours to read. */
const MAX_STEPS = 2000;

@Injectable()
export class PrismaPipelineStore implements PipelineStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async allocations(applicationId: string): Promise<StoredAllocation[]> {
    const rows = await this.database.client.allocation.findMany({
      where: { applicationId, state: 'placed' },
      orderBy: [{ releaseId: 'asc' }, { replica: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      releaseId: row.releaseId,
      index: row.replica,
      nodeId: row.nodeId,
      container: row.container,
      port: row.port,
      cpuMillis: row.cpuMillis,
      memoryBytes: Number(row.memoryBytes),
    }));
  }

  async place(
    organizationId: string,
    applicationId: string,
    releaseId: string,
    replicas: readonly Omit<StoredAllocation, 'id' | 'releaseId'>[],
    now: Date,
  ): Promise<boolean> {
    const inserted = await this.database.client.allocation.createMany({
      data: replicas.map((replica) => ({
        id: uuidv7(),
        organizationId,
        applicationId,
        releaseId,
        nodeId: replica.nodeId,
        replica: replica.index,
        container: replica.container,
        port: replica.port,
        cpuMillis: replica.cpuMillis,
        memoryBytes: BigInt(replica.memoryBytes),
        state: 'placed',
        createdAt: now,
        updatedAt: now,
      })),
      skipDuplicates: true,
    });
    return inserted.count === replicas.length;
  }

  async stop(applicationId: string, releaseIds: readonly string[], now: Date): Promise<void> {
    await this.database.client.allocation.updateMany({
      where: { applicationId, releaseId: { in: [...releaseIds] }, state: 'placed' },
      data: { state: 'stopped', updatedAt: now },
    });
  }

  async recordDigest(releaseId: string, digest: string): Promise<boolean> {
    if (!DIGEST.test(digest)) return false;
    // Write-once, also enforced by the releases_write_once trigger and the column grant.
    const updated = await this.database.client.release.updateMany({
      where: { id: releaseId, imageDigest: null },
      data: { imageDigest: digest },
    });
    return updated.count === 1;
  }

  async release(releaseId: string): Promise<Release | undefined> {
    const row = await this.database.client.release.findFirst({ where: { id: releaseId } });
    if (!row) return undefined;
    const config: unknown = row.config;
    return {
      id: row.id,
      organizationId: row.organizationId,
      applicationId: row.applicationId,
      number: row.number,
      image: row.image,
      imageDigest: row.imageDigest,
      config: config as ShipkeepConfig,
      configSha: row.configSha,
      commitSha: row.commitSha,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
  }

  async steps(deploymentId: string): Promise<Map<string, StepOutcome>> {
    const rows = await this.database.client.agentAction.findMany({
      where: { idempotencyKey: { startsWith: `d:${deploymentId}:` } },
      select: { idempotencyKey: true, state: true, result: true, error: true },
      take: MAX_STEPS,
    });
    return new Map(rows.map((row) => [row.idempotencyKey, outcome(row)]));
  }

  async nodes(organizationId: string): Promise<NodeView[]> {
    const rows = await this.database.client.node.findMany({
      where: { organizationId, status: { not: 'removed' } },
      orderBy: { name: 'asc' },
      take: 1000,
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      lastHeartbeatAt: row.lastHeartbeatAt,
      labels: record(row.labels, (value) => (typeof value === 'string' ? value : undefined)),
      facts: record(row.facts, (value) =>
        typeof value === 'string' || typeof value === 'number' ? value : undefined,
      ),
    }));
  }

  async application(applicationId: string): Promise<PipelineApplication | undefined> {
    const row = await this.database.client.application.findFirst({
      where: { id: applicationId },
      select: {
        id: true,
        organizationId: true,
        projectId: true,
        environmentId: true,
        name: true,
        installationId: true,
        repositoryId: true,
      },
    });
    if (!row) return undefined;
    const { installationId, repositoryId, ...application } = row;
    return {
      ...application,
      // A Git application's repository, as GitHub identifies it: a build fetches it (ADR 0030).
      repository:
        installationId !== null && repositoryId !== null
          ? { installationId: Number(installationId), repositoryId: Number(repositoryId) }
          : null,
    };
  }

  async lockPlacement(organizationId: string): Promise<void> {
    // A transaction-level advisory lock: PostgreSQL releases it on commit and on rollback. A hash
    // collision would only make two organizations wait for each other.
    const hash = createHash('sha256').update(`shipkeep:placement:${organizationId}`).digest('hex');
    const lock = BigInt.asIntN(64, BigInt(`0x${hash.slice(0, 16)}`));
    await this.database.client.$queryRaw`SELECT pg_advisory_xact_lock(${lock})::text`;
  }

  async load(organizationId: string, replacing?: ReplacingRelease): Promise<Map<string, NodeLoad>> {
    // One query, so the replaced replicas and the load come from the same snapshot.
    const rows = await this.database.client.allocation.findMany({
      where: { organizationId, state: 'placed' },
      select: {
        nodeId: true,
        applicationId: true,
        releaseId: true,
        cpuMillis: true,
        memoryBytes: true,
      },
    });
    return nodeLoads(
      rows.map((row) => ({ ...row, memoryBytes: Number(row.memoryBytes) })),
      replacing,
    );
  }
}

/**
 * An action row as the planner sees it. Results are proto JSON, which omits default values: a
 * release task without `exitCode` exited 0, and a health check without `healthy` was unhealthy.
 */
/** The final states that are not a success: the ones a reason explains. */
const UNSUCCESSFUL: ReadonlySet<string> = new Set(['failed', 'compensated']);

export function outcome(row: {
  state: string;
  result: unknown;
  error: string | null;
}): StepOutcome {
  const state = STEP_STATES.find((candidate) => candidate === row.state) ?? 'failed';
  const result =
    typeof row.result === 'object' && row.result !== null
      ? (row.result as Record<string, unknown>)
      : {};
  const nested = (name: string): Record<string, unknown> | undefined => {
    const value = result[name];
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  };
  const health = nested('healthCheck');
  const task = nested('releaseTask');
  const built = nested('buildImage');
  const digest = built?.['imageDigest'];
  return {
    state,
    // A code, never the text: an action that did not end well has a reason, the others none.
    reason: UNSUCCESSFUL.has(state) ? actionReason(row.error) : null,
    ...(typeof result['containerId'] === 'string' ? { containerId: result['containerId'] } : {}),
    ...(health ? { healthy: health['healthy'] === true } : {}),
    ...(task ? { exitCode: typeof task['exitCode'] === 'number' ? task['exitCode'] : 0 } : {}),
    // Only a digest the agent could have answered: the release pins it.
    ...(typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(digest)
      ? { imageDigest: digest }
      : {}),
  };
}

function record<T>(value: unknown, keep: (entry: unknown) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [key, entry] of Object.entries(value)) {
    const kept = keep(entry);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}
