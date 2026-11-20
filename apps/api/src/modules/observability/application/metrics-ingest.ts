import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Inject, Injectable, Logger, type OnModuleInit, Optional } from '@nestjs/common';
import type { MetricsReport } from '@shipkeep/proto-ts';

import { MetricsReports } from '../../fleet/application/metrics-reports';
import type { NodeIdentity } from '../../fleet/domain/node-identity';
import { exposition, type Measures, samples, validMeasures } from '../domain/metrics';

import {
  METRICS_STORE,
  METRICS_TARGETS,
  METRICS_TRANSACTION,
  type MetricsStore,
  type MetricsTargets,
  type MetricsTransaction,
} from './ports';

/** Reports written at once; more are dropped, never queued: a later sample replaces them. */
const MAX_PENDING = 8;
/** A sample time further than this from the control plane's clock is replaced by it. */
const MAX_SKEW_MS = 5 * 60_000;

/** The measures of a report, as numbers, or undefined when any is out of bounds. */
export function measuresOf(report: MetricsReport): Measures | undefined {
  const node = report.node;
  return validMeasures({
    node: node && {
      cpuSeconds: node.cpuSeconds,
      cpuCores: node.cpuCores,
      memoryUsedBytes: Number(node.memoryUsedBytes),
      memoryTotalBytes: Number(node.memoryTotalBytes),
      diskUsedBytes: Number(node.diskUsedBytes),
      diskTotalBytes: Number(node.diskTotalBytes),
      networkReceivedBytes: Number(node.networkReceivedBytes),
      networkSentBytes: Number(node.networkSentBytes),
    },
    containers: report.containers.map((container) => ({
      name: container.name,
      cpuSeconds: container.cpuSeconds,
      memoryUsedBytes: Number(container.memoryUsedBytes),
      memoryLimitBytes: Number(container.memoryLimitBytes),
      networkReceivedBytes: Number(container.networkReceivedBytes),
      networkSentBytes: Number(container.networkSentBytes),
    })),
    hosts: report.hosts.map((host) => ({
      host: host.host,
      responses2xx: Number(host.responses2xx),
      responses3xx: Number(host.responses3xx),
      responses4xx: Number(host.responses4xx),
      responses5xx: Number(host.responses5xx),
      responsesOther: Number(host.responsesOther),
      durationSeconds: host.durationSeconds,
    })),
  });
}

/**
 * Writes the metrics nodes report to VictoriaMetrics (ADR 0024, SPEC 12). The identity comes from
 * the node's certificate, and every label from the control plane's records of that node: a report
 * can describe only the node's own workloads. Metrics change no state, so nothing is audited.
 */
@Injectable()
export class MetricsIngest implements OnModuleInit {
  private readonly logger = new Logger(MetricsIngest.name);
  private pending = 0;
  private dropping = false;

  constructor(
    private readonly reports: MetricsReports,
    @Inject(METRICS_TARGETS) private readonly targets: MetricsTargets,
    @Inject(METRICS_TRANSACTION) private readonly transaction: MetricsTransaction,
    @Optional() @Inject(METRICS_STORE) private readonly store: MetricsStore | null,
  ) {}

  onModuleInit(): void {
    // Without a store, nothing registers and the stream tells agents to send no metrics.
    if (this.store)
      this.reports.register((identity, report) => {
        this.accept(identity, report);
      });
  }

  /** Starts writing a report and returns at once: the agent's stream never waits for the store. */
  accept(identity: NodeIdentity, report: MetricsReport): void {
    if (this.pending >= MAX_PENDING) {
      if (!this.dropping) this.logger.warn('metrics store is slow: reports are dropped');
      this.dropping = true;
      return;
    }
    this.dropping = false;
    this.pending++;
    void this.record(identity, report)
      .catch((error: unknown) => {
        this.logger.warn(
          { nodeId: identity.nodeId, reason: error instanceof Error ? error.message : 'unknown' },
          'metrics not written',
        );
      })
      .finally(() => {
        this.pending--;
      });
  }

  async record(identity: NodeIdentity, report: MetricsReport, now = new Date()): Promise<void> {
    const store = this.store;
    if (!store) return;
    const measures = measuresOf(report);
    if (!measures) {
      // The agent bounds and validates too: this is a bug or a tampered agent.
      this.logger.warn({ nodeId: identity.nodeId }, 'invalid metrics report ignored');
      return;
    }
    const found = await this.transaction.runTenant(identity.organizationId, () =>
      this.targets.onNode(
        identity.organizationId,
        identity.nodeId,
        measures.containers.map((container) => container.name),
        measures.hosts.map((host) => host.host),
      ),
    );
    const sampled = report.sampledAt ? timestampDate(report.sampledAt) : now;
    const at = Math.abs(sampled.getTime() - now.getTime()) <= MAX_SKEW_MS ? sampled : now;
    await store.write(exposition(samples(measures, identity, found.containers, found.hosts), at));
  }
}
