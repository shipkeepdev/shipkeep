import { Injectable } from '@nestjs/common';
import type { LogBatch } from '@shipkeep/proto-ts';

import { LogsBusyError, LogsNotKeptError } from '../domain/logs-not-kept';
import type { NodeIdentity } from '../domain/node-identity';

/** What a delivery takes from the stream that brought its batch (#473). */
export interface LogDelivery {
  /** Ends with the stream, replaced, cancelled or closed: its batch is then not written. */
  readonly signal: AbortSignal;
  /** Checks again that the node may still write, before a write that waited for its quota. */
  readonly stillAllowed: () => Promise<void>;
}

/** Stores one batch; it resolves once the batch is kept, which the agent's acknowledgement waits for. */
export type LogBatchHandler = (
  identity: NodeIdentity,
  batch: LogBatch,
  delivery: LogDelivery,
) => Promise<void>;

/**
 * Deliveries one node may have under way at once, across its streams, a replaced one included.
 * The store bounds its own work across nodes.
 */
export const MAX_NODE_DELIVERIES = 2;

/**
 * Hands agents' log batches to the context that stores them (ADR 0029), which registers here when
 * a log store is configured. Welcome says whether one is: without it, agents ship none. The work
 * under way is bounded per node, whatever its streams do.
 */
@Injectable()
export class LogBatches {
  private handler: LogBatchHandler | undefined;
  private readonly underway = new Map<string, number>();

  register(handler: LogBatchHandler): void {
    this.handler = handler;
  }

  get accepting(): boolean {
    return this.handler !== undefined;
  }

  async deliver(identity: NodeIdentity, batch: LogBatch, delivery: LogDelivery): Promise<void> {
    if (!this.handler) throw new LogsNotKeptError();
    delivery.signal.throwIfAborted();
    const key = `${identity.organizationId}/${identity.nodeId}`;
    const node = this.underway.get(key) ?? 0;
    if (node >= MAX_NODE_DELIVERIES) throw new LogsBusyError();
    this.underway.set(key, node + 1);
    try {
      await this.handler(identity, batch, delivery);
    } finally {
      const left = (this.underway.get(key) ?? 1) - 1;
      if (left === 0) this.underway.delete(key);
      else this.underway.set(key, left);
    }
  }
}
