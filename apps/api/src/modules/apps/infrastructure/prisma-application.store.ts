import { Injectable } from '@nestjs/common';
import type { ShipkeepConfig } from '@shipkeep/config-schema';
import { v7 as uuidv7 } from 'uuid';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { ApplicationStore } from '../application/ports';
import type {
  Application,
  ApplicationConfig,
  ApplicationHost,
  ApplicationTarget,
} from '../domain/application';
import type { NodeStatus } from '../../fleet/domain/node';

const MAX_LISTED = 500;
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
  ): Promise<Application | undefined> {
    const id = uuidv7();
    const inserted = await this.database.client.application.createMany({
      data: {
        id,
        ...target,
        name: config.name,
        source: config.source,
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
  ): Promise<Application | undefined> {
    // Compare-and-swap on the configuration hash: a concurrent edit makes this one fail.
    const updated = await this.database.client.application.updateMany({
      where: {
        id: application.id,
        organizationId: application.organizationId,
        configSha: expectedSha,
      },
      data: { config: JSON.parse(config.canonical) as object, configSha, updatedAt: now },
    });
    if (updated.count !== 1) return undefined;
    return { ...application, config: config.config, configSha, updatedAt: now };
  }

  async syncDomains(
    application: Pick<Application, 'id' | 'organizationId'>,
    hostnames: readonly string[],
    now: Date,
  ): Promise<string | undefined> {
    const { id: applicationId, organizationId } = application;
    await this.database.client.domain.deleteMany({
      where: { applicationId, hostname: { notIn: [...hostnames] } },
    });
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
    return hostnames.find((hostname) => !mine.has(hostname));
  }

  async find(target: ApplicationTarget, applicationId: string): Promise<Application | undefined> {
    const row = await this.database.client.application.findFirst({
      where: { ...target, id: applicationId },
    });
    return row ? application(row) : undefined;
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
  config: unknown;
  configSha: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Application {
  if (row.source !== 'image') throw new Error('Unknown application source in storage.');
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    name: row.name,
    source: row.source,
    // Stored only after schema validation; the column CHECK keeps it an object.
    config: row.config as ShipkeepConfig,
    configSha: row.configSha,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
