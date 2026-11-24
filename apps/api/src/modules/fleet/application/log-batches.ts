import { Injectable } from '@nestjs/common';
import type { LogBatch } from '@shipkeep/proto-ts';

import type { NodeIdentity } from '../domain/node-identity';

/** Stores one batch; it resolves once the batch is kept, which the agent's acknowledgement waits for. */
export type LogBatchHandler = (identity: NodeIdentity, batch: LogBatch) => Promise<void>;

/**
 * Hands agents' log batches to the context that stores them (ADR 0029), which registers here when
 * a log store is configured. Welcome says whether one is: without it, agents ship none.
 */
@Injectable()
export class LogBatches {
  private handler: LogBatchHandler | undefined;

  register(handler: LogBatchHandler): void {
    this.handler = handler;
  }

  get accepting(): boolean {
    return this.handler !== undefined;
  }

  async deliver(identity: NodeIdentity, batch: LogBatch): Promise<void> {
    if (!this.handler) throw new Error('no log store');
    await this.handler(identity, batch);
  }
}
