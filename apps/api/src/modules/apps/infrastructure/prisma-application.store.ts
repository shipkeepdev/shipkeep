import { Injectable } from '@nestjs/common';
import type { ShipkeepConfig } from '@shipkeep/config-schema';
import { v7 as uuidv7 } from 'uuid';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { ApplicationStore } from '../application/ports';
import type { Application, ApplicationConfig, ApplicationTarget } from '../domain/application';

const MAX_LISTED = 500;

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

  async find(target: ApplicationTarget, applicationId: string): Promise<Application | undefined> {
    const row = await this.database.client.application.findFirst({
      where: { ...target, id: applicationId },
    });
    return row ? application(row) : undefined;
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
