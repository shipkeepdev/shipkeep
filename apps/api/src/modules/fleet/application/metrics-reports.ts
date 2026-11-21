import { Injectable } from '@nestjs/common';
import type { MetricsReport } from '@shipkeep/proto-ts';

import type { NodeIdentity } from '../domain/node-identity';

export type MetricsReportHandler = (identity: NodeIdentity, report: MetricsReport) => void;

/**
 * Hands agent metrics reports to the context that stores them (ADR 0024), which registers here
 * when a metrics store is configured. The stream announces in Welcome whether one is: without
 * it, agents send none. The handler must not wait for the store: heartbeats share the stream.
 */
@Injectable()
export class MetricsReports {
  private handler: MetricsReportHandler | undefined;

  register(handler: MetricsReportHandler): void {
    this.handler = handler;
  }

  get accepting(): boolean {
    return this.handler !== undefined;
  }

  deliver(identity: NodeIdentity, report: MetricsReport): void {
    this.handler?.(identity, report);
  }
}
