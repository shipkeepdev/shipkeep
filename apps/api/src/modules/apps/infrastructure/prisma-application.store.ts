import { Injectable } from '@nestjs/common';
import type { ShipkeepConfig } from '@shipkeep/config-schema';
import { v7 as uuidv7 } from 'uuid';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type {
  ApplicationStore,
  DomainSync,
  RepositoryFollower,
  RepositoryHead,
} from '../application/ports';
import type {
  Application,
  ApplicationConfig,
  ApplicationHost,
  ApplicationRepository,
  ApplicationTarget,
} from '../domain/application';
import type { NodeStatus } from '../../fleet/domain/node';

const MAX_LISTED = 500;
/** A push deploys at most this many applications: one per environment that follows the branch. */
export const MAX_FOLLOWERS = 20;
/** Placement spreads replicas over at most this many nodes long before the bound matters. */
const MAX_HOSTS = 200;

@Injectable()
export class PrismaApplicationStore implements ApplicationStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async create(
    target: ApplicationTarget,
    config: ApplicationConfig,
    configSha: string,
    actorId: string,
    now: Date,
    repository: ApplicationRepository | null = null,
  ): Promise<Application | undefined> {
    const id = uuidv7();
    const inserted = await this.database.client.application.createMany({
      data: {
        id,
        ...target,
        name: config.name,
        source: config.source,
        ...(repository
          ? {
              installationId: BigInt(repository.installationId),
              repositoryId: BigInt(repository.repositoryId),
              repository: repository.fullName,
              branch: repository.branch,
              configPath: repository.configPath,
              commitSha: repository.commitSha,
            }
          : {}),
        config: JSON.parse(config.canonical) as object,
        configSha,
        createdBy: actorId,
        createdAt: now,
        updatedAt: now,
      },
      skipDuplicates: true,
    });
    if (inserted.count !== 1) return undefined;
    return {
      id,
      ...target,
      name: config.name,
      source: config.source,
      repository,
      config: config.config,
      configSha,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
  }

  async replaceConfig(
    application: Application,
    expectedSha: string,
    config: ApplicationConfig,
    configSha: string,
    now: Date,
    head?: RepositoryHead,
  ): Promise<Application | undefined> {
    const repository =
      head && application.repository
        ? { ...application.repository, fullName: head.fullName, commitSha: head.commitSha }
        : application.repository;
    // Compare-and-swap on the configuration hash: a concurrent edit makes this one fail.
    const updated = await this.database.client.application.updateMany({
      where: {
        id: application.id,
        organizationId: application.organizationId,
        configSha: expectedSha,
        ...(head ? { source: 'git' } : {}),
      },
      data: {
        config: JSON.parse(config.canonical) as object,
        configSha,
        ...(head ? { repository: head.fullName, commitSha: head.commitSha } : {}),
        updatedAt: now,
      },
    });
    if (updated.count !== 1) return undefined;
    return { ...application, repository, config: config.config, configSha, updatedAt: now };
  }

  async syncDomains(
    application: Pick<Application, 'id' | 'organizationId'>,
    hostnames: readonly string[],
    now: Date,
  ): Promise<DomainSync> {
    const { id: applicationId, organizationId } = application;
    // A domain the configuration drops stays reserved while a placed release still serves it
    // (#302); one it lists again is reserved as before.
    await this.database.client.domain.updateMany({
      where: { applicationId, hostname: { notIn: [...hostnames] }, releasingAt: null },
      data: { releasingAt: now },
    });
    await this.database.client.domain.updateMany({
      where: { applicationId, hostname: { in: [...hostnames] }, releasingAt: { not: null } },
      data: { releasingAt: null },
    });
    const released = await this.releaseUnservedDomains(application);
    await this.database.client.domain.createMany({
      data: hostnames.map((hostname) => ({
        id: uuidv7(),
        organizationId,
        applicationId,
        hostname,
        createdAt: now,
      })),
      skipDuplicates: true,
    });
    // Anything still not ours lost to an existing claim of another application.
    const owned = await this.database.client.domain.findMany({
      where: { applicationId, hostname: { in: [...hostnames] } },
      select: { hostname: true },
    });
    const mine = new Set(owned.map((row) => row.hostname));
    return { taken: hostnames.find((hostname) => !mine.has(hostname)), released };
  }

  async releaseUnservedDomains(
    application: Pick<Application, 'id' | 'organizationId'>,
  ): Promise<string[]> {
    // One statement, so one snapshot: a reservation is kept when a release of the application
    // lists the domain and has placed replicas (the pipeline stops replicas only once their route
    // no longer needs them), or belongs to a deployment not finished yet, which routes the
    // domains of its snapshot. All of them are kept while a route change of the application is
    // not settled on a node: one still under way (it can still apply, whatever happened since),
    // or one that ended without effect while the route there may still serve them, until a later
    // route change on that node succeeds. That is a failed change of either kind, and a route
    // removal that never ran (cancelled, expired or compensated): the route it was to remove is
    // still there. An addition that never ran installed nothing. Separate reads could each see a
    // different state.
    const rows = await this.database.client.$queryRaw<{ hostname: string }[]>`
      DELETE FROM domains d
      WHERE d.organization_id = ${application.organizationId}::uuid
        AND d.application_id = ${application.id}::uuid
        AND d.releasing_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM agent_actions aa
          JOIN nodes n ON n.organization_id = aa.organization_id AND n.id = aa.node_id
          WHERE aa.organization_id = d.organization_id
            AND aa.application_id = d.application_id
            AND aa.kind IN ('upsertRoute', 'removeRoute')
            AND n.status <> 'removed'
            AND (
              aa.state IN ('queued', 'pending', 'running', 'compensating')
              OR (
                (
                  aa.state = 'failed'
                  OR (
                    aa.kind = 'removeRoute'
                    AND aa.state IN ('cancelled', 'expired', 'compensated')
                  )
                )
                AND NOT EXISTS (
                  SELECT 1 FROM agent_actions later
                  WHERE later.organization_id = aa.organization_id
                    AND later.application_id = aa.application_id
                    AND later.node_id = aa.node_id
                    AND later.kind IN ('upsertRoute', 'removeRoute')
                    AND later.state = 'succeeded'
                    AND later.created_at > aa.created_at
                )
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM releases r
          WHERE r.organization_id = d.organization_id
            AND r.application_id = d.application_id
            AND jsonb_typeof(r.config -> 'domains') = 'array'
            AND (r.config -> 'domains') ? d.hostname
            AND (
              EXISTS (SELECT 1 FROM allocations a WHERE a.release_id = r.id AND a.state = 'placed')
              OR EXISTS (
                SELECT 1 FROM deployments dp
                WHERE dp.release_id = r.id
                  AND dp.state NOT IN ('succeeded', 'failed', 'cancelled', 'rolled_back')
              )
            )
        )
      RETURNING d.hostname`;
    return rows.map((row) => row.hostname).sort();
  }

  async find(target: ApplicationTarget, applicationId: string): Promise<Application | undefined> {
    const row = await this.database.client.application.findFirst({
      where: { ...target, id: applicationId },
    });
    return row ? application(row) : undefined;
  }

  async findById(organizationId: string, applicationId: string): Promise<Application | undefined> {
    const row = await this.database.client.application.findFirst({
      where: { organizationId, id: applicationId },
    });
    return row ? application(row) : undefined;
  }

  async lock(target: Pick<Application, 'id' | 'organizationId'>): Promise<boolean> {
    const rows = await this.database.client.$queryRaw<{ id: string }[]>`
      SELECT id FROM applications
      WHERE organization_id = ${target.organizationId}::uuid AND id = ${target.id}::uuid
      FOR UPDATE`;
    return rows.length === 1;
  }

  async delete(target: Pick<Application, 'id' | 'organizationId'>): Promise<boolean> {
    const deleted = await this.database.client.application.deleteMany({
      where: { organizationId: target.organizationId, id: target.id },
    });
    return deleted.count === 1;
  }

  async hosts(application: Pick<Application, 'id' | 'organizationId'>): Promise<ApplicationHost[]> {
    const rows = await this.database.client.node.findMany({
      where: {
        organizationId: application.organizationId,
        status: { not: 'removed' },
        allocations: {
          some: {
            organizationId: application.organizationId,
            applicationId: application.id,
            state: 'placed',
            observation: { is: { state: 'running' } },
          },
        },
      },
      select: { status: true, lastHeartbeatAt: true, publicAddresses: true },
      orderBy: { id: 'asc' },
      take: MAX_HOSTS,
    });
    return rows.map((row) => ({ ...row, status: row.status as NodeStatus }));
  }

  async followers(
    organizationId: string,
    push: { installationId: number; repositoryId: number; branch: string },
  ): Promise<Application[]> {
    // Served by the partial index applications_repository_branch_idx.
    const rows = await this.database.client.application.findMany({
      where: {
        organizationId,
        source: 'git',
        repositoryId: BigInt(push.repositoryId),
        branch: push.branch,
        installationId: BigInt(push.installationId),
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_FOLLOWERS,
    });
    return rows.map(application);
  }

  async follower(
    organizationId: string,
    applicationId: string,
  ): Promise<RepositoryFollower | undefined> {
    const row = await this.database.client.application.findFirst({
      where: { id: applicationId, organizationId, source: 'git' },
      include: { environment: { select: { protected: true } } },
    });
    return row
      ? { application: application(row), protectedEnvironment: row.environment.protected }
      : undefined;
  }

  async list(target: ApplicationTarget): Promise<Application[]> {
    const rows = await this.database.client.application.findMany({
      where: target,
      orderBy: { name: 'asc' },
      take: MAX_LISTED,
    });
    return rows.map(application);
  }
}

function application(row: {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  name: string;
  source: string;
  installationId: bigint | null;
  repositoryId: bigint | null;
  repository: string | null;
  branch: string | null;
  configPath: string | null;
  commitSha: string | null;
  config: unknown;
  configSha: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Application {
  if (row.source !== 'image' && row.source !== 'git')
    throw new Error('Unknown application source in storage.');
  // The table's CHECK sets every repository column for a Git application, and none otherwise.
  const repository =
    row.source === 'git' &&
    row.installationId !== null &&
    row.repositoryId !== null &&
    row.repository !== null &&
    row.branch !== null &&
    row.configPath !== null &&
    row.commitSha !== null
      ? {
          installationId: Number(row.installationId),
          repositoryId: Number(row.repositoryId),
          fullName: row.repository,
          branch: row.branch,
          configPath: row.configPath,
          commitSha: row.commitSha,
        }
      : null;
  if ((row.source === 'git') !== (repository !== null))
    throw new Error('Inconsistent application source in storage.');
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    name: row.name,
    source: row.source,
    repository,
    // Stored only after schema validation; the column CHECK keeps it an object.
    config: row.config as ShipkeepConfig,
    configSha: row.configSha,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
