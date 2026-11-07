import { Injectable } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { ObservationStore } from '../application/ports';
import {
  OBSERVED_STATES,
  type ObservationChange,
  type ObservedAllocation,
  type ObservedState,
} from '../domain/observations';

@Injectable()
export class PrismaObservationStore implements ObservationStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async placedOnNode(organizationId: string, nodeId: string): Promise<ObservedAllocation[]> {
    const rows = await this.database.client.allocation.findMany({
      where: { organizationId, nodeId, state: 'placed' },
      include: { observation: true },
    });
    return rows.map((row) => ({
      id: row.id,
      applicationId: row.applicationId,
      container: row.container,
      observation: row.observation
        ? { state: observedState(row.observation.state), observedAt: row.observation.observedAt }
        : null,
    }));
  }

  async apply(
    organizationId: string,
    changes: readonly ObservationChange[],
    now: Date,
  ): Promise<void> {
    for (const change of changes) {
      const data = { containerId: change.containerId, state: change.state, observedAt: now };
      await this.database.client.allocationObservation.upsert({
        where: { allocationId: change.allocationId },
        create: { allocationId: change.allocationId, organizationId, ...data },
        update: data,
      });
    }
  }
}

function observedState(value: string): ObservedState {
  return OBSERVED_STATES.find((state) => state === value) ?? 'missing';
}
