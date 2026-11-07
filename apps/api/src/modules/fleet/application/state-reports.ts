import { Injectable } from '@nestjs/common';
import type { StateReport } from '@shipkeep/proto-ts';

import type { NodeIdentity } from '../domain/node-identity';

export type StateReportHandler = (identity: NodeIdentity, report: StateReport) => Promise<void>;

/**
 * Hands agent state reports to whoever owns the observed workloads. The deployments context
 * depends on fleet, so it registers here instead of fleet importing it. Without a handler,
 * reports are dropped: they are refreshed every 30 seconds anyway.
 */
@Injectable()
export class StateReports {
  private handler: StateReportHandler | undefined;

  register(handler: StateReportHandler): void {
    this.handler = handler;
  }

  async deliver(identity: NodeIdentity, report: StateReport): Promise<void> {
    await this.handler?.(identity, report);
  }
}
