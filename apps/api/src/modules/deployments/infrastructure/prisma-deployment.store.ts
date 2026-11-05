import { Injectable } from '@nestjs/common';
import type { ShipkeepConfig } from '@shipkeep/config-schema';
import { DEPLOYMENT_STATES, type DeploymentState } from '@shipkeep/domain';
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
    return rows.map((row) => {
      // Snapshot of a schema-validated configuration; the column CHECK keeps it an object.
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
        createdBy: row.createdBy,
        createdAt: row.createdAt,
      };
    });
  }

  async finish(record: DeploymentRecord, expected: DeploymentState, now: Date): Promise<boolean> {
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

function deployment(row: {
  id: string;
  organizationId: string;
  applicationId: string;
  releaseId: string;
  state: string;
  planBuild: boolean;
  planRelease: boolean;
  trigger: string;
  actorId: string | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}): DeploymentRecord {
  const state = DEPLOYMENT_STATES.find((candidate) => candidate === row.state);
  const trigger = DEPLOYMENT_TRIGGERS.find((candidate) => candidate === row.trigger);
  if (!state || !trigger) throw new Error('Unknown deployment state or trigger in storage.');
  return {
    id: row.id,
    organizationId: row.organizationId,
    applicationId: row.applicationId,
    releaseId: row.releaseId,
    state,
    plan: { build: row.planBuild, release: row.planRelease },
    trigger,
    actorId: row.actorId,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
