import { Injectable } from '@nestjs/common';
import type { StateReport } from '@shipkeep/proto-ts';

import type { NodeIdentity } from '../domain/node-identity';

export type StateReportHandler = (identity: NodeIdentity, report: StateReport) => Promise<void>;

/**
 * Hands agent state reports to the contexts that own what they describe: deployments for the
 * replicas, apps for the certificates of domains. Those contexts depend on fleet, so they register
 * here instead of fleet importing them. Without a handler, reports are dropped: they are
 * refreshed every 30 seconds anyway.
 */
@Injectable()
export class StateReports {
  private readonly handlers: StateReportHandler[] = [];

  register(handler: StateReportHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Every handler sees the report, even when an earlier one fails, so that one context's outage
   * does not hide the report from the others. The first failure is then rethrown.
   */
  async deliver(identity: NodeIdentity, report: StateReport): Promise<void> {
    let failure: Error | undefined;
    for (const handler of this.handlers) {
      try {
        await handler(identity, report);
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error('state report handler failed');
      }
    }
    if (failure) throw failure;
  }
}
