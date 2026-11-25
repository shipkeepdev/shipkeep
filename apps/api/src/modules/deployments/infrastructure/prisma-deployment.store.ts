import { Injectable } from '@nestjs/common';
import type { ShipkeepConfig } from '@shipkeep/config-schema';
import { DEPLOYMENT_STATES, type DeploymentState, MAINTENANCE_CHANGES } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { Application } from '../../apps/domain/application';
import type { DeploymentStore } from '../application/ports';
import {
  DEPLOYMENT_TRIGGERS,
  type DeploymentRecord,
  type DeploymentTrigger,
  type Release,
  type ReleaseDraft,
} from '../domain/release';

const FINISHED: DeploymentState[] = ['succeeded', 'failed', 'cancelled', 'rolled_back'];
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

  async cleanupPending(application: { id: string; organizationId: string }): Promise<boolean> {
    // One statement, so one snapshot. Each container action names its container: by name in a
    // removal (`remove:<container>`), by replica in a creation or a cleanup (`create:<n>`,
    // `cleanup:<n>`), which the allocation of that deployment's release names. A server that is
    // removed holds nothing any more.
    const rows = await this.database.client.$queryRaw<{ pending: boolean }[]>`
      WITH actions AS (
        SELECT aa.organization_id, aa.application_id, aa.node_id, aa.kind, aa.state,
          aa.attempts, aa.created_at,
          CASE
            WHEN aa.idempotency_key ~ '^d:[0-9a-f-]{36}:remove:[a-z0-9-]{1,63}$'
              THEN split_part(aa.idempotency_key, ':', 4)
            WHEN aa.idempotency_key ~ '^d:[0-9a-f-]{36}:(create|cleanup):[0-9]{1,4}$' THEN (
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
            'upsertRoute', 'removeRoute')
      )
      SELECT EXISTS (
        SELECT 1 FROM actions x
        WHERE
          -- Still under way: it can still apply, whatever happened since.
          x.state IN ('queued', 'pending', 'running', 'compensating')
          -- A route change that ended without effect while the route may still serve the
          -- domains, until a later route change on that server succeeded (as for #302).
          OR (
            x.kind IN ('upsertRoute', 'removeRoute')
            AND (
              x.state = 'failed'
              OR (x.kind = 'removeRoute' AND x.state IN ('cancelled', 'expired', 'compensated'))
            )
            AND NOT EXISTS (
              SELECT 1 FROM actions later
              WHERE later.node_id = x.node_id
                AND later.kind IN ('upsertRoute', 'removeRoute')
                AND later.state = 'succeeded'
                AND later.created_at > x.created_at
            )
          )
          -- A container that may be there: created, or sent and of unknown outcome, or a removal
          -- that did not succeed, with no later removal of that container on that server that
          -- did. A container no action names is taken as there.
          OR (
            (
              (
                x.kind = 'createContainer'
                AND (x.state = 'succeeded' OR (x.state IN ('failed', 'expired') AND x.attempts > 0))
              )
              OR (x.kind = 'removeContainer' AND x.state <> 'succeeded')
            )
            AND NOT EXISTS (
              SELECT 1 FROM actions removed
              WHERE removed.node_id = x.node_id
                AND removed.kind = 'removeContainer'
                AND removed.state = 'succeeded'
                AND removed.container = x.container
                AND removed.created_at > x.created_at
            )
          )
      ) AS pending`;
    return rows[0]?.pending ?? false;
  }

  async createRelease(
    application: Application,
    draft: ReleaseDraft,
    actorId: string,
    now: Date,
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
    actorId: string,
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
