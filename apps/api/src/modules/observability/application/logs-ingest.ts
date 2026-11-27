import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Inject, Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import { type LogBatch, LogStream } from '@shipkeep/proto-ts';

import { type LogDelivery, LogBatches } from '../../fleet/application/log-batches';
import { LogsBusyError } from '../../fleet/domain/logs-not-kept';
import type { NodeIdentity } from '../../fleet/domain/node-identity';
import {
  batchBytes,
  ByteRate,
  type LogInput,
  logRecords,
  MAX_LOG_WAIT_MS,
  MAX_LOG_WAITS,
  MAX_LOG_WRITES,
  validEntries,
} from '../domain/logs';

import {
  LOGS_STORE,
  type LogsStore,
  METRICS_TARGETS,
  METRICS_TRANSACTION,
  type MetricsTargets,
  type MetricsTransaction,
} from './ports';

/** How often buckets that have refilled are forgotten. */
const SWEEP_MS = 60_000;

/**
 * Writes the log batches agents send to VictoriaLogs (ADR 0029, SPEC 12), with labels from the
 * control plane's records of the node. Each node writes at most its rate, charged before anything
 * is looked up: past it, the batch waits, and so does the agent's acknowledgement. Logs change no
 * state, so nothing is audited.
 */
@Injectable()
export class LogsIngest implements OnModuleInit {
  private readonly logger = new Logger(LogsIngest.name);
  private readonly rates = new Map<string, ByteRate>();
  private swept = Date.now();
  /** Batches waiting for their quota, and batches being looked up and written, of all nodes. */
  private waits = 0;
  private writes = 0;

  constructor(
    private readonly batches: LogBatches,
    @Inject(METRICS_TARGETS) private readonly targets: MetricsTargets,
    @Inject(METRICS_TRANSACTION) private readonly transaction: MetricsTransaction,
    @Optional() @Inject(LOGS_STORE) private readonly store: LogsStore | null,
    @Optional()
    @Inject('LOGS_SLEEP')
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void> = wait,
    @Optional()
    @Inject('LOGS_LIMITS')
    private readonly limits: { readonly waits: number; readonly writes: number } = {
      waits: MAX_LOG_WAITS,
      writes: MAX_LOG_WRITES,
    },
  ) {}

  onModuleInit(): void {
    if (this.store)
      this.batches.register((identity, batch, delivery) => this.record(identity, batch, delivery));
  }

  /**
   * Writes one batch, unless its stream ends first (#473): the wait for the quota and the write
   * stop with it; the lookup, which cannot be stopped, runs to its end, and then nothing is
   * written. A write that waited checks the node again first. Waits and writes are each bounded
   * across nodes: a batch past a bound is refused and charged nothing, so a node within its rate
   * is never held up by the waits of others.
   */
  async record(
    identity: NodeIdentity,
    batch: LogBatch,
    delivery: LogDelivery,
    now = new Date(),
  ): Promise<void> {
    const store = this.store;
    if (!store) return;
    const { signal } = delivery;
    signal.throwIfAborted();
    const bytes = batchBytes(batch.entries.map((e) => e.line));
    const rate = this.rate(identity.nodeId);
    const delay = rate.reserve(bytes, MAX_LOG_WAIT_MS);
    if (delay === undefined) throw new LogsBusyError();
    if (delay > 0) {
      if (this.waits >= this.limits.waits) {
        rate.refund(bytes);
        throw new LogsBusyError();
      }
      // The check of the node after the wait holds its place too: a slow store cannot let
      // delayed batches pile up past the bound.
      this.waits++;
      try {
        await this.sleep(delay, signal);
        await delivery.stillAllowed();
      } finally {
        this.waits--;
      }
      // Ended during that check: no lookup starts for it.
      signal.throwIfAborted();
    }
    if (this.writes >= this.limits.writes) {
      rate.refund(bytes);
      throw new LogsBusyError();
    }
    this.writes++;
    try {
      await this.write(store, identity, batch, signal, now);
    } finally {
      this.writes--;
    }
  }

  private async write(
    store: LogsStore,
    identity: NodeIdentity,
    batch: LogBatch,
    signal: AbortSignal,
    now: Date,
  ): Promise<void> {
    const entries = validEntries(batch.entries.map(entryOf).filter((entry) => entry !== undefined));
    if (entries.length < batch.entries.length)
      this.logger.warn({ nodeId: identity.nodeId }, 'malformed log entries dropped');
    if (entries.length === 0) return;
    const containers = [
      ...new Set(entries.filter((entry) => entry.actionId === '').map((entry) => entry.container)),
    ];
    const actions = [
      ...new Set(entries.filter((entry) => entry.actionId !== '').map((entry) => entry.actionId)),
    ];
    const found = await this.transaction.runTenant(identity.organizationId, async () => ({
      containers: containers.length
        ? (await this.targets.onNode(identity.organizationId, identity.nodeId, containers, []))
            .containers
        : [],
      // A build's output (ADR 0032): only builds this node was given.
      builds: actions.length
        ? await this.targets.buildsOnNode(identity.organizationId, identity.nodeId, actions)
        : [],
    }));
    signal.throwIfAborted();
    await store.write(logRecords(entries, found.containers, identity, now, found.builds), signal);
  }

  private rate(nodeId: string): ByteRate {
    const at = Date.now();
    if (at - this.swept >= SWEEP_MS) {
      this.swept = at;
      for (const [id, bucket] of this.rates) if (bucket.full(at)) this.rates.delete(id);
    }
    let rate = this.rates.get(nodeId);
    if (!rate) {
      rate = new ByteRate();
      this.rates.set(nodeId, rate);
    }
    return rate;
  }
}

/** The entry as the domain reads it, or undefined when its stream is neither of the two. */
function entryOf(entry: LogBatch['entries'][number]): LogInput | undefined {
  const stream =
    entry.stream === LogStream.STDOUT
      ? 'stdout'
      : entry.stream === LogStream.STDERR
        ? 'stderr'
        : undefined;
  if (!stream) return undefined;
  return {
    container: entry.container,
    actionId: entry.actionId,
    stream,
    time: entry.time ? timestampDate(entry.time) : new Date(Number.NaN),
    nanos: entry.time?.nanos ?? 0,
    line: entry.line,
    truncated: entry.truncated,
  };
}

/** Waits `ms`, or rejects at once when `signal` aborts, its timer cleared. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}
