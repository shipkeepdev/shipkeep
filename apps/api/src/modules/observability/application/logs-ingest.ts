import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Inject, Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import { type LogBatch, LogStream } from '@shipkeep/proto-ts';

import { LogBatches } from '../../fleet/application/log-batches';
import type { NodeIdentity } from '../../fleet/domain/node-identity';
import { ByteRate, type LogInput, logRecords, validEntries } from '../domain/logs';

import {
  LOGS_STORE,
  type LogsStore,
  METRICS_TARGETS,
  METRICS_TRANSACTION,
  type MetricsTargets,
  type MetricsTransaction,
} from './ports';

/**
 * Writes the log batches agents send to VictoriaLogs (ADR 0029, SPEC 12), with labels from the
 * control plane's records of the node. Each node writes at most its rate: past it, the batch
 * waits, and so does the agent's acknowledgement. Logs change no state, so nothing is audited.
 */
@Injectable()
export class LogsIngest implements OnModuleInit {
  private readonly logger = new Logger(LogsIngest.name);
  private readonly rates = new Map<string, ByteRate>();

  constructor(
    private readonly batches: LogBatches,
    @Inject(METRICS_TARGETS) private readonly targets: MetricsTargets,
    @Inject(METRICS_TRANSACTION) private readonly transaction: MetricsTransaction,
    @Optional() @Inject(LOGS_STORE) private readonly store: LogsStore | null,
    @Optional() @Inject('LOGS_SLEEP') private readonly sleep: (ms: number) => Promise<void> = wait,
  ) {}

  onModuleInit(): void {
    if (this.store) this.batches.register((identity, batch) => this.record(identity, batch));
  }

  async record(identity: NodeIdentity, batch: LogBatch, now = new Date()): Promise<void> {
    const store = this.store;
    if (!store) return;
    const entries = validEntries(batch.entries.map(entryOf));
    if (entries.length < batch.entries.length)
      this.logger.warn({ nodeId: identity.nodeId }, 'malformed log entries dropped');
    if (entries.length === 0) return;
    const found = await this.transaction.runTenant(identity.organizationId, () =>
      this.targets.onNode(
        identity.organizationId,
        identity.nodeId,
        [...new Set(entries.map((entry) => entry.container))],
        [],
      ),
    );
    const records = logRecords(entries, found.containers, identity, now);
    const bytes = records.reduce((sum, record) => sum + record._msg.length, 0);
    const delay = this.rate(identity.nodeId).take(bytes);
    if (delay > 0) await this.sleep(delay);
    await store.write(records);
  }

  private rate(nodeId: string): ByteRate {
    let rate = this.rates.get(nodeId);
    if (!rate) {
      rate = new ByteRate();
      this.rates.set(nodeId, rate);
    }
    return rate;
  }
}

function entryOf(entry: LogBatch['entries'][number]): LogInput {
  return {
    container: entry.container,
    stream: entry.stream === LogStream.STDERR ? 'stderr' : 'stdout',
    time: entry.time ? timestampDate(entry.time) : new Date(Number.NaN),
    line: entry.line,
    truncated: entry.truncated,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
