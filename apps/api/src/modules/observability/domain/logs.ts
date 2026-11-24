import type { ContainerTarget } from './metrics';

/** Bounds of a batch (ADR 0029). Entries past them, or malformed, are dropped. */
export const MAX_LOG_ENTRIES = 256;
export const MAX_LOG_LINE_BYTES = 16 * 1024;
/** A line time further than this from the control plane's clock is replaced by it. */
export const MAX_LOG_SKEW_MS = 5 * 60_000;
/** What one node may write: 512 KiB per second, with bursts up to 4 MiB. */
export const LOG_RATE = { bytesPerSecond: 512 * 1024, burstBytes: 4 * 1024 * 1024 } as const;

const CONTAINER = /^(?:[a-f0-9]{64}|sk-[a-z0-9-]{1,60})$/;

export interface LogInput {
  readonly container: string;
  readonly stream: 'stdout' | 'stderr';
  readonly time: Date;
  readonly line: string;
  readonly truncated: boolean;
}

/** One line as VictoriaLogs stores it: its time, its text and labels the control plane sets. */
export interface LogRecord {
  readonly _time: string;
  readonly _msg: string;
  readonly org: string;
  readonly project: string;
  readonly env: string;
  readonly app: string;
  readonly instance: string;
  readonly node: string;
  readonly stream: 'stdout' | 'stderr';
  readonly truncated?: true;
}

/** The well-formed entries of a batch, within its bounds. */
export function validEntries(entries: readonly LogInput[]): LogInput[] {
  return entries
    .slice(0, MAX_LOG_ENTRIES)
    .filter(
      (entry) =>
        CONTAINER.test(entry.container) &&
        Number.isFinite(entry.time.getTime()) &&
        new TextEncoder().encode(entry.line).length <= MAX_LOG_LINE_BYTES,
    );
}

/**
 * The records of entries whose container is one of the node's placed allocations, labelled from
 * that allocation: an agent can write lines for its own workloads only, and none of its names
 * becomes a label. Entries of other containers are dropped.
 */
export function logRecords(
  entries: readonly LogInput[],
  targets: readonly ContainerTarget[],
  scope: { organizationId: string; nodeId: string },
  now: Date,
): LogRecord[] {
  const byName = new Map(targets.map((target) => [target.container, target]));
  const records: LogRecord[] = [];
  for (const entry of entries) {
    const target = byName.get(entry.container);
    if (!target) continue;
    const skewed = Math.abs(entry.time.getTime() - now.getTime()) > MAX_LOG_SKEW_MS;
    records.push({
      _time: (skewed ? now : entry.time).toISOString(),
      _msg: entry.line,
      org: scope.organizationId,
      project: target.projectId,
      env: target.environmentId,
      app: target.applicationId,
      instance: String(target.replica),
      node: scope.nodeId,
      stream: entry.stream,
      ...(entry.truncated ? { truncated: true as const } : {}),
    });
  }
  return records;
}

/** A token bucket in bytes: how long a write of `bytes` must wait, and takes them. */
export class ByteRate {
  private tokens: number;
  private at: number;

  constructor(
    private readonly rate = LOG_RATE.bytesPerSecond,
    private readonly burst = LOG_RATE.burstBytes,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.at = now;
  }

  /** Milliseconds to wait before writing `bytes`; the bucket counts them as taken. */
  take(bytes: number, now = Date.now()): number {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    this.tokens -= bytes;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens / this.rate) * 1000);
  }
}
