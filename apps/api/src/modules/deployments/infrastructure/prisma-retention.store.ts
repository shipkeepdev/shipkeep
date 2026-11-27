import { Injectable } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { RetentionStore } from '../application/ports';

/** An application's releases and their deployments, as image retention reads them (ADR 0030). */
@Injectable()
export class PrismaRetentionStore implements RetentionStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async releases(applicationId: string): ReturnType<RetentionStore['releases']> {
    const application = await this.database.client.application.findFirst({
      where: { id: applicationId },
      select: {
        projectId: true,
        environmentId: true,
        releases: {
          select: {
            number: true,
            image: true,
            deployments: { select: { state: true, finishedAt: true } },
          },
        },
      },
    });
    return application ?? undefined;
  }
}
