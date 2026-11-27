import { Injectable } from '@nestjs/common';
import type { ShipkeepConfig } from '@shipkeep/config-schema';
import { DEPLOYMENT_STATES, type DeploymentState, MAINTENANCE_CHANGES } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { Application } from '../../apps/domain/application';
import type { DeploymentStore, Leftovers } from '../application/ports';
import {
  DEPLOYMENT_TRIGGERS,
  type DeploymentRecord,
  type DeploymentTrigger,
  type Release,
  type ReleaseDraft,
} from '../domain/release';

const FINISHED: DeploymentState[] = ['succeeded', 'failed', 'cancelled', 'rolled_back'];
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Keys of a deployment's (`d:`) or a deletion's (`c:`) removal of a container, by its name. */
const KEY_BY_NAME = `^[dc]:${UUID}:remove:[a-z0-9-]{1,63}$`;
/** Keys of a deployment's creation or cleanup of a replica, by its number. */
const KEY_BY_REPLICA = `^d:${UUID}:(create|cleanup):[0-9]{1,4}$`;
const MAX_LISTED = 50;

@Injectable()
export class PrismaDeploymentStore implements DeploymentStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async active(applicationId: string): Promise<DeploymentRecord | undefined> {
    const row = await this.database.client.deployment.findFirst({
      where: { applicationId, state: { notIn: FINISHED } },
    });
    return row ? deployment(row) : undefined;
  }

  async leftovers(application: { id: string; organizationId: string }): Promise<Leftovers> {
    // One statement, so one snapshot. Each container action names its container: by name in a
    // removal (`remove:<container>`), by replica in a creation or a cleanup (`create:<n>`,
    // `cleanup:<n>`), which the allocation of that deployment's release names. A server that is
    // removed holds nothing any more. An action that never reached its server (no attempt) did
    // nothing, unless it succeeded.
    const rows = await this.database.client.$queryRaw<
      {
        what: 'underway' | 'container' | 'route';
        node_id: string | null;
        container: string | null;
        deployment_id: string | null;
      }[]
    >`
      WITH actions AS (
        SELECT aa.node_id, aa.kind, aa.state, aa.attempts, aa.created_at, aa.deployment_id,
          CASE
            WHEN aa.idempotency_key ~ ${KEY_BY_NAME} THEN split_part(aa.idempotency_key, ':', 4)
            WHEN aa.idempotency_key ~ ${KEY_BY_REPLICA} THEN (
              SELECT a.container FROM deployments dp
              JOIN allocations a ON a.organization_id = dp.organization_id
                AND a.release_id = dp.release_id
                AND a.replica = split_part(aa.idempotency_key, ':', 4)::int
              WHERE dp.organization_id = aa.organization_id
                AND dp.id = split_part(aa.idempotency_key, ':', 2)::uuid
            )
          END AS container
        FROM agent_actions aa
        JOIN nodes n ON n.organization_id = aa.organization_id AND n.id = aa.node_id
        WHERE aa.organization_id = ${application.organizationId}::uuid
          AND aa.application_id = ${application.id}::uuid
          AND n.status <> 'removed'
          AND aa.kind IN ('createContainer', 'startContainer', 'stopContainer', 'removeContainer',
            'runReleaseTask', 'upsertRoute', 'removeRoute')
      ),
      -- A container that may be there: created, or sent and not undone, or a removal sent that did
      -- not succeed, with no later removal of that container on that server that did.
      containers AS (
        SELECT DISTINCT ON (x.node_id, x.container) x.node_id, x.container, x.deployment_id
        FROM actions x
        WHERE (
            (x.kind = 'createContainer'
              AND (x.state = 'succeeded' OR (x.attempts > 0 AND x.state <> 'compensated')))
            OR (x.kind = 'removeContainer' AND x.state <> 'succeeded' AND x.attempts > 0)
          )
          AND NOT EXISTS (
            SELECT 1 FROM actions removed
            WHERE removed.node_id = x.node_id
              AND removed.kind = 'removeContainer'
              AND removed.state = 'succeeded'
              AND removed.container IS NOT DISTINCT FROM x.container
              AND removed.created_at > x.created_at
          )
        ORDER BY x.node_id, x.container, x.created_at DESC
      ),
      -- The last route change on each server that may have run: unless it is a removal that
      -- succeeded, the route may still serve the domains.
      routes AS (
        SELECT DISTINCT ON (x.node_id) x.node_id, x.kind, x.state, x.deployment_id
        FROM actions x
        WHERE x.kind IN ('upsertRoute', 'removeRoute') AND (x.state = 'succeeded' OR x.attempts > 0)
        ORDER BY x.node_id, x.created_at DESC
      )
      SELECT 'underway' AS what, NULL::uuid AS node_id, NULL AS container, NULL::uuid AS deployment_id
        FROM actions WHERE state IN ('queued', 'pending', 'running', 'compensating')
      UNION ALL
      SELECT 'container', node_id, container, deployment_id FROM containers
      UNION ALL
      SELECT 'route', node_id, NULL, deployment_id FROM routes
        WHERE NOT (kind = 'removeRoute' AND state = 'succeeded')`;
    const at = (row: (typeof rows)[number]) => ({
      nodeId: row.node_id ?? '',
      deploymentId: row.deployment_id ?? '',
    });
    return {
      underway: rows.some((row) => row.what === 'underway'),
      containers: rows
        .filter((row) => row.what === 'container')
        .map((row) => ({ ...at(row), container: row.container })),
      routes: rows.filter((row) => row.what === 'route').map(at),
    };
  }

  async createRelease(
    application: Application,
    draft: ReleaseDraft,
    actorId: string | null,
    now: Date,
    commitSha: string | null = null,
  ): Promise<Release | undefined> {
    const last = await this.database.client.release.aggregate({
      where: { applicationId: application.id },
      _max: { number: true },
    });
    const release: Release = {
      id: uuidv7(),
      organizationId: application.organizationId,
      applicationId: application.id,
      number: (last._max.number ?? 0) + 1,
      image: draft.image,
      imageDigest: null,
      config: application.config,
      configSha: application.configSha,
      commitSha,
      createdBy: actorId,
      createdAt: now,
    };
    const config: object = application.config;
    const inserted = await this.database.client.release.createMany({
      data: { ...release, config },
      skipDuplicates: true,
    });
    return inserted.count === 1 ? release : undefined;
  }

  async copyRelease(source: Release, actorId: string, now: Date): Promise<Release | undefined> {
    const last = await this.database.client.release.aggregate({
      where: { applicationId: source.applicationId },
      _max: { number: true },
    });
    const release: Release = {
      ...source,
      id: uuidv7(),
      number: (last._max.number ?? 0) + 1,
      createdBy: actorId,
      createdAt: now,
    };
    const config: object = source.config;
    const inserted = await this.database.client.release.createMany({
      data: { ...release, config },
      skipDuplicates: true,
    });
    return inserted.count === 1 ? release : undefined;
  }

  async release(applicationId: string, releaseId: string): Promise<Release | undefined> {
    const row = await this.database.client.release.findFirst({
      where: { applicationId, id: releaseId },
    });
    return row ? releaseRecord(row) : undefined;
  }

  async serving(applicationId: string): Promise<DeploymentRecord | undefined> {
    const row = await this.database.client.deployment.findFirst({
      where: { applicationId, state: 'succeeded' },
      orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }],
    });
    // After a stop nothing serves, whatever ran before it.
    return row && !row.planStop ? deployment(row) : undefined;
  }

  async succeededOf(
    applicationId: string,
    releaseIds: readonly string[],
  ): Promise<DeploymentRecord[]> {
    const rows = await this.database.client.deployment.findMany({
      where: { applicationId, state: 'succeeded', releaseId: { in: [...releaseIds] } },
      take: MAX_LISTED,
    });
    return rows.map(deployment);
  }

  async queue(
    release: Release,
    draft: ReleaseDraft,
    trigger: DeploymentTrigger,
    actorId: string | null,
    now: Date,
  ): Promise<DeploymentRecord | undefined> {
    const record: DeploymentRecord = {
      id: uuidv7(),
      organizationId: release.organizationId,
      applicationId: release.applicationId,
      releaseId: release.id,
      state: 'queued',
      plan: draft.plan,
      trigger,
      actorId,
      startedAt: now,
      finishedAt: null,
      error: null,
    };
    // The partial unique index makes a second active deployment a skipped duplicate.
    const inserted = await this.database.client.deployment.createMany({
      data: {
        id: record.id,
        organizationId: record.organizationId,
        applicationId: record.applicationId,
        releaseId: record.releaseId,
        state: record.state,
        planBuild: record.plan.build,
        planRelease: record.plan.release,
        planStop: record.plan.stop === true,
        planMaintenance: record.plan.maintenance ?? null,
        trigger,
        actorId,
        startedAt: now,
        updatedAt: now,
      },
      skipDuplicates: true,
    });
    return inserted.count === 1 ? record : undefined;
  }

  async find(applicationId: string, deploymentId: string): Promise<DeploymentRecord | undefined> {
    const row = await this.database.client.deployment.findFirst({
      where: { applicationId, id: deploymentId },
    });
    return row ? deployment(row) : undefined;
  }

  async byId(deploymentId: string): Promise<DeploymentRecord | undefined> {
    const row = await this.database.client.deployment.findFirst({ where: { id: deploymentId } });
    return row ? deployment(row) : undefined;
  }

  async lockState(deploymentId: string): Promise<DeploymentState | undefined> {
    const rows = await this.database.client.$queryRaw<{ state: string }[]>`
      SELECT state FROM deployments WHERE id = ${deploymentId}::uuid FOR UPDATE`;
    const row = rows.at(0);
    if (!row) return undefined;
    const state = DEPLOYMENT_STATES.find((candidate) => candidate === row.state);
    if (!state) throw new Error('Unknown deployment state in storage.');
    return state;
  }

  async list(applicationId: string): Promise<DeploymentRecord[]> {
    const rows = await this.database.client.deployment.findMany({
      where: { applicationId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: MAX_LISTED,
    });
    return rows.map(deployment);
  }

  async latestRelease(applicationId: string): Promise<Release | undefined> {
    const row = await this.database.client.release.findFirst({
      where: { applicationId },
      orderBy: { number: 'desc' },
    });
    return row ? releaseRecord(row) : undefined;
  }

  async releases(applicationId: string): Promise<Release[]> {
    const rows = await this.database.client.release.findMany({
      where: { applicationId },
      orderBy: { number: 'desc' },
      take: MAX_LISTED,
    });
    return rows.map(releaseRecord);
  }

  async transition(
    record: DeploymentRecord,
    expected: DeploymentState,
    now: Date,
  ): Promise<boolean> {
    const updated = await this.database.client.deployment.updateMany({
      where: {
        id: record.id,
        organizationId: record.organizationId,
        state: expected,
      },
      data: {
        state: record.state,
        error: record.error,
        finishedAt: record.finishedAt,
        updatedAt: now,
      },
    });
    return updated.count === 1;
  }
}

function releaseRecord(row: {
  id: string;
  organizationId: string;
  applicationId: string;
  number: number;
  image: string;
  imageDigest: string | null;
  config: unknown;
  configSha: string;
  commitSha: string | null;
  createdBy: string | null;
  createdAt: Date;
}): Release {
  return {
    id: row.id,
    organizationId: row.organizationId,
    applicationId: row.applicationId,
    number: row.number,
    image: row.image,
    imageDigest: row.imageDigest,
    // Snapshot of a schema-validated configuration; the column CHECK keeps it an object.
    config: row.config as ShipkeepConfig,
    configSha: row.configSha,
    commitSha: row.commitSha,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

function deployment(row: {
  id: string;
  organizationId: string;
  applicationId: string;
  releaseId: string;
  state: string;
  planBuild: boolean;
  planRelease: boolean;
  planStop: boolean;
  planMaintenance: string | null;
  trigger: string;
  actorId: string | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}): DeploymentRecord {
  const state = DEPLOYMENT_STATES.find((candidate) => candidate === row.state);
  const trigger = DEPLOYMENT_TRIGGERS.find((candidate) => candidate === row.trigger);
  if (!state || !trigger) throw new Error('Unknown deployment state or trigger in storage.');
  const maintenance = MAINTENANCE_CHANGES.find((change) => change === row.planMaintenance);
  if (row.planMaintenance !== null && !maintenance)
    throw new Error('Unknown maintenance change in storage.');
  return {
    id: row.id,
    organizationId: row.organizationId,
    applicationId: row.applicationId,
    releaseId: row.releaseId,
    state,
    plan: {
      build: row.planBuild,
      release: row.planRelease,
      ...(row.planStop ? { stop: true } : {}),
      ...(maintenance ? { maintenance } : {}),
    },
    trigger,
    actorId: row.actorId,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
