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
/**
 * The longest a batch waits for its node's quota: one that would wait longer is refused at once,
 * charged nothing, so the debt a node can build, its streams replaced or not, stays bounded.
 */
export const MAX_LOG_WAIT_MS = 10_000;
/**
 * Batches the control plane holds while they wait for their node's quota, of all nodes: at most
 * 64 KiB each. A node within its rate never waits, so it never needs one of these places.
 */
export const MAX_LOG_WAITS = 1024;
/** Batches the control plane looks up and writes at once, of all nodes. */
export const MAX_LOG_WRITES = 256;
/** The least a batch costs, so that a flood of small or empty batches is held back too. */
export const LOG_BATCH_MIN_BYTES = 16 * 1024;

const CONTAINER = /^(?:[a-f0-9]{64}|sk-[a-z0-9-]{1,60})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LogInput {
  /** Empty for an action's output. */
  readonly container: string;
  /** The action whose output this is, a build's (ADR 0032); empty for a container's line. */
  readonly actionId: string;
  readonly stream: 'stdout' | 'stderr';
  readonly time: Date;
  /** The nanoseconds within its second, as Docker stamped it: a resent line has the same. */
  readonly nanos: number;
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
  /** The replica, or `build` for a build's output. */
  readonly instance: string;
  readonly node: string;
  readonly stream: 'stdout' | 'stderr' | 'build';
  /** The deployment a build's output belongs to (ADR 0032). */
  readonly deployment?: string;
  readonly truncated?: true;
}

/** A build action the control plane queued on a node, and its deployment (ADR 0032). */
export interface BuildTarget {
  readonly actionId: string;
  readonly deploymentId: string;
  readonly applicationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

/** The well-formed entries of a batch, within its bounds. */
export function validEntries(entries: readonly LogInput[]): LogInput[] {
  return entries.slice(0, MAX_LOG_ENTRIES).filter(
    (entry) =>
      // A container's line, or an action's output, never both.
      (entry.actionId === ''
        ? CONTAINER.test(entry.container)
        : entry.container === '' && UUID.test(entry.actionId)) &&
      Number.isFinite(entry.time.getTime()) &&
      Number.isInteger(entry.nanos) &&
      entry.nanos >= 0 &&
      entry.nanos < 1_000_000_000 &&
      utf8.encode(entry.line).length <= MAX_LOG_LINE_BYTES,
  );
}

/**
 * The records of entries whose container is one of the node's placed allocations, labelled from
 * that allocation, and of entries whose action is a build the control plane queued on that node,
 * labelled with its deployment (ADR 0032): an agent can write lines for its own workloads and
 * builds only, and none of its names becomes a label. Other entries, or past retention, are
 * dropped.
 */
export function logRecords(
  entries: readonly LogInput[],
  targets: readonly ContainerTarget[],
  scope: { organizationId: string; nodeId: string },
  now: Date,
  builds: readonly BuildTarget[] = [],
): LogRecord[] {
  const byName = new Map(targets.map((target) => [target.container, target]));
  const byAction = new Map(builds.map((build) => [build.actionId, build]));
  const records: LogRecord[] = [];
  for (const entry of entries) {
    const target = entry.actionId === '' ? byName.get(entry.container) : undefined;
    const build = entry.actionId === '' ? undefined : byAction.get(entry.actionId);
    const owner = target ?? build;
    if (!owner) continue;
    const age = now.getTime() - entry.time.getTime();
    if (age > LOG_RETENTION_MS) continue;
    records.push({
      _time:
        age < -MAX_LOG_SKEW_MS
          ? logTime(now, now.getUTCMilliseconds() * 1_000_000)
          : logTime(entry.time, entry.nanos),
      _msg: entry.line,
      org: scope.organizationId,
      project: owner.projectId,
      env: owner.environmentId,
      app: owner.applicationId,
      instance: target ? String(target.replica) : 'build',
      node: scope.nodeId,
      stream: target ? entry.stream : 'build',
      ...(build ? { deployment: build.deploymentId } : {}),
      ...(entry.truncated ? { truncated: true as const } : {}),
    });
  }
  return records;
}

const utf8 = new TextEncoder();

/**
 * What a batch costs against its node's rate: its lines in UTF-8 bytes, whether they are kept or
 * not, and at least LOG_BATCH_MIN_BYTES.
 */
export function batchBytes(lines: readonly string[]): number {
  const bytes = lines.reduce((sum, line) => sum + utf8.encode(line).length, 0);
  return Math.max(LOG_BATCH_MIN_BYTES, bytes);
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

  /**
   * Milliseconds to wait before writing `bytes`, which the bucket then counts as taken; undefined,
   * taking nothing, when the wait would be longer than `maxWaitMs`. A write taken stays taken,
   * even when its stream ends before it is written: reconnecting never gives a node its bytes back.
   */
  reserve(bytes: number, maxWaitMs: number, now = Date.now()): number | undefined {
    const tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate) - bytes;
    const waitMs = tokens >= 0 ? 0 : Math.ceil((-tokens / this.rate) * 1000);
    if (waitMs > maxWaitMs) return undefined;
    this.tokens = tokens;
    this.at = now;
    return waitMs;
  }

  /** Gives back the bytes of a write the control plane refused after taking them. */
  refund(bytes: number): void {
    this.tokens += bytes;
  }

  /** True once the bucket has refilled: forgetting it then changes nothing. */
  full(now = Date.now()): boolean {
    return this.tokens + ((now - this.at) / 1000) * this.rate >= this.burst;
  }
}

/** At most this many lines answer one search. */
export const MAX_LOG_RESULTS = 500;
/** The longest search text. */
export const MAX_LOG_TEXT = 256;

export interface LogSearch {
  readonly organizationId: string;
  readonly applicationId: string;
  /** Text the lines contain, matched as a case-sensitive substring; empty for every line. */
  readonly text: string;
  readonly stream?: 'stdout' | 'stderr' | undefined;
  readonly instance?: number | undefined;
  readonly from: Date;
  /**
   * `from` as the client wrote it, with up to nine digits of fraction: a live view reads forward
   * from a line's exact time, which a Date would cut to the millisecond.
   */
  readonly fromExact?: string | undefined;
  readonly to: Date;
  readonly limit: number;
  /** `newest` first for a search, `oldest` first for a live view reading forward from `from`. */
  readonly order?: 'newest' | 'oldest' | undefined;
}

/**
 * The LogsQL query of a search: filters on labels the control plane wrote, from identifiers it
 * validated, and the person's text as one quoted substring, which cannot add a filter or a pipe.
 */
export function logsQuery(search: LogSearch): string {
  if (!UUID.test(search.organizationId) || !UUID.test(search.applicationId))
    throw new Error('invalid log search scope');
  const parts = [
    `{org="${search.organizationId}",app="${search.applicationId}"}`,
    `_time:[${exactTime(search.fromExact) ?? search.from.toISOString()}, ${search.to.toISOString()}]`,
    // A build's output is read with its deployment, never with the application's lines.
    '-stream:=build',
  ];
  if (search.stream) parts.push(`stream:=${search.stream}`);
  if (search.instance !== undefined) parts.push(`instance:="${String(search.instance)}"`);
  if (search.text) parts.push(`*${quoted(search.text)}*`);
  const sort = search.order === 'oldest' ? '_time' : '_time desc';
  return `${parts.join(' ')} | sort by (${sort}) | limit ${String(search.limit)}`;
}

const EXACT_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** A UTC time with up to nine digits of fraction, as it may go into the query; else undefined. */
function exactTime(value: string | undefined): string | undefined {
  return value !== undefined && EXACT_TIME.test(value) ? value : undefined;
}

/** A LogsQL quoted string: backslashes and quotes escaped, control characters removed. */
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
  const time = fullTime(value['_time']);
  const line = value['_msg'];
  const stream = value['stream'];
  const instance = value['instance'];
  if (
    time === undefined ||
    typeof line !== 'string' ||
    (stream !== 'stdout' && stream !== 'stderr') ||
    typeof instance !== 'string' ||
    !/^\d{1,3}$/.test(instance)
  )
    return undefined;
  return {
    time,
    stream,
    instance: Number(instance),
    line,
    truncated: value['truncated'] === 'true',
  };
}

/** A line's time in RFC 3339 with nine digits of fraction, as Docker stamps it. */
export function logTime(time: Date, nanos: number): string {
  return `${time.toISOString().slice(0, 19)}.${String(nanos).padStart(9, '0')}Z`;
}

const STORED_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,9}|)Z$/;

/**
 * A time VictoriaLogs answered, with nine digits of fraction: it trims trailing zeros, and times
 * of one length sort as text. Undefined when it is not such a time.
 */
function fullTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = STORED_TIME.exec(value);
  if (!match) return undefined;
  return `${match[1]}.${match[2].slice(1).padEnd(9, '0')}Z`;
}

/**
 * The lines without repeats, in their order. An agent sends a line again after an outage (at least
 * once, ADR 0029); the copy has the same time, replica, stream and text, so it shows once.
 */
export function distinctLines(lines: readonly LogLine[]): LogLine[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = JSON.stringify([line.time, line.instance, line.stream, line.line]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
