import type { ContainerTarget } from './metrics';

/** Bounds of a batch (ADR 0029). Entries past them, or malformed, are dropped. */
export const MAX_LOG_ENTRIES = 256;
export const MAX_LOG_LINE_BYTES = 16 * 1024;
/** A line time further than this ahead of the control plane's clock is replaced by it. */
export const MAX_LOG_SKEW_MS = 5 * 60_000;
/**
 * VictoriaLogs keeps 30 days (`-retentionPeriod=30d`) and refuses older lines. A line sent again
 * after an outage keeps its own time; one older than this is dropped here instead.
 */
export const LOG_RETENTION_MS = 30 * 24 * 3_600_000;
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
 * becomes a label. Entries of other containers, or past retention, are dropped.
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
    const age = now.getTime() - entry.time.getTime();
    if (age > LOG_RETENTION_MS) continue;
    records.push({
      _time: (age < -MAX_LOG_SKEW_MS ? now : entry.time).toISOString(),
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

/** At most this many lines answer one search. */
export const MAX_LOG_RESULTS = 500;
/** The longest search text. */
export const MAX_LOG_TEXT = 256;

export interface LogSearch {
  readonly organizationId: string;
  readonly applicationId: string;
  /** Text the lines contain, as a phrase; empty for every line. */
  readonly text: string;
  readonly stream?: 'stdout' | 'stderr' | undefined;
  readonly instance?: number | undefined;
  readonly from: Date;
  readonly to: Date;
  readonly limit: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The LogsQL query of a search: filters on labels the control plane wrote, from identifiers it
 * validated, and the person's text as one quoted phrase, which cannot add a filter or a pipe.
 */
export function logsQuery(search: LogSearch): string {
  if (!UUID.test(search.organizationId) || !UUID.test(search.applicationId))
    throw new Error('invalid log search scope');
  const parts = [
    `{org="${search.organizationId}",app="${search.applicationId}"}`,
    `_time:[${search.from.toISOString()}, ${search.to.toISOString()}]`,
  ];
  if (search.stream) parts.push(`stream:=${search.stream}`);
  if (search.instance !== undefined) parts.push(`instance:="${String(search.instance)}"`);
  if (search.text) parts.push(quoted(search.text));
  return `${parts.join(' ')} | sort by (_time desc) | limit ${String(search.limit)}`;
}

/** A LogsQL phrase: backslashes and quotes escaped, control characters removed. */
export function quoted(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what is removed
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** One line of a search's answer, as the API returns it. */
export interface LogLine {
  readonly time: string;
  readonly stream: 'stdout' | 'stderr';
  readonly instance: number;
  readonly line: string;
  readonly truncated: boolean;
}

/** A line of VictoriaLogs' answer, or undefined when it is not one Shipkeep wrote. */
export function logLineOf(record: unknown): LogLine | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const value = record as Record<string, unknown>;
  const time = value['_time'];
  const line = value['_msg'];
  const stream = value['stream'];
  const instance = Number(value['instance']);
  if (
    typeof time !== 'string' ||
    typeof line !== 'string' ||
    (stream !== 'stdout' && stream !== 'stderr') ||
    !Number.isInteger(instance)
  )
    return undefined;
  return { time, stream, instance, line, truncated: value['truncated'] === 'true' };
}
