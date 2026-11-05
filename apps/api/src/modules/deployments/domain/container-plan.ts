import type { ShipkeepConfig } from '@shipkeep/config-schema';
import { InvalidInputError } from '@shipkeep/domain';

/** What the pipeline asks an agent to run; the worker turns it into a proto `ContainerSpec`. */
export interface ContainerPlan {
  /** `^sk-[a-z0-9-]{1,60}$`, unique per node (application id suffix, release, replica). */
  readonly name: string;
  /** Digest-pinned image (`<name>@sha256:…`). */
  readonly image: string;
  /** Argv; empty keeps the image default. Never a shell string (SPEC 2.2). */
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Secret names; the worker injects their values at enqueue time, never the planner. */
  readonly secrets: readonly string[];
  /** Container port exposed on the Docker network only. */
  readonly port: number | null;
  readonly network: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly cpuMillis: number;
  readonly memoryBytes: number;
  readonly restart: 'always' | 'never';
}

export interface HealthPlan {
  /** HTTP path probed on `port` (SPEC 2: `run.healthcheck.path`). */
  readonly path: string;
  readonly port: number;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly startPeriodMs: number;
  readonly healthyThreshold: number;
}

const SIZE_UNITS: Readonly<Record<string, number>> = {
  '': 1,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
};
const DURATION_UNITS: ReadonlyMap<string, number> = new Map([
  ['ms', 1],
  ['s', 1e3],
  ['m', 6e4],
  ['h', 3.6e6],
]);

/** `0.5` or `500m` (SPEC 2) as whole millicores. */
export function cpuMillis(value: string | undefined): number {
  if (value === undefined) return 0;
  const millis = /^([0-9]+)m$/.exec(value);
  const cores = /^([0-9]+(?:\.[0-9]+)?)$/.exec(value);
  const result = millis?.[1]
    ? Number(millis[1])
    : cores?.[1]
      ? Math.round(Number(cores[1]) * 1000)
      : NaN;
  return bounded(result, 'cpu');
}

/** Kubernetes-style size (`512Mi`, `2G`, bare bytes) as bytes. */
export function sizeBytes(value: string | undefined): number {
  if (value === undefined) return 0;
  const match = /^([0-9]+)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(value);
  const unit = SIZE_UNITS[match?.[2] ?? ''];
  return bounded(match?.[1] && unit ? Number(match[1]) * unit : NaN, 'memory');
}

/** Go-style duration (`30s`, `1m30s`, `500ms`) in milliseconds. */
export function durationMs(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^([0-9]+(ms|s|m|h))+$/.test(value)) return bounded(NaN, 'duration');
  let total = 0;
  for (const [, amount, unit] of value.matchAll(/([0-9]+)(ms|s|m|h)/g))
    total += Number(amount) * (DURATION_UNITS.get(unit) ?? NaN);
  return bounded(total, 'duration');
}

/** Docker network of an environment: one per environment and node. */
export function environmentNetwork(environmentId: string): string {
  return `sk-env-${environmentId.replace(/-/g, '')}`;
}

/** Container of replica `index` of release `number`, unique per node across environments. */
export function containerName(
  application: { readonly id: string; readonly name: string },
  release: number,
  index: number | 'release',
): string {
  const suffix = index === 'release' ? 'task' : String(index);
  return `sk-${application.name.slice(0, 24)}-${application.id.slice(-12)}-r${String(release)}-${suffix}`;
}

/** The release's replica or release-task container (SPEC 2: `run`, `release`, `resources`). */
export function containerPlan(input: {
  readonly config: ShipkeepConfig;
  readonly image: string;
  readonly name: string;
  readonly network: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly task: boolean;
}): ContainerPlan {
  const { config } = input;
  return {
    name: input.name,
    image: input.image,
    command: input.task ? [...(config.release?.command ?? [])] : [...(config.run?.command ?? [])],
    env: Object.fromEntries(
      Object.entries(config.env ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    secrets: [...new Set(config.secrets ?? [])].sort(),
    port: input.task ? null : (config.run?.port ?? null),
    network: input.network,
    labels: input.labels,
    cpuMillis: cpuMillis(config.resources?.cpu),
    memoryBytes: sizeBytes(config.resources?.memory),
    restart: input.task ? 'never' : 'always',
  };
}

/** `run.healthcheck` as a probe plan; null when the configuration defines none. */
export function healthPlan(config: ShipkeepConfig): HealthPlan | null {
  const check = config.run?.healthcheck;
  const port = config.run?.port;
  if (!check || port === undefined) return null;
  return {
    path: check.path,
    port,
    intervalMs: durationMs(check.interval, 5_000),
    timeoutMs: durationMs(check.timeout, 2_000),
    startPeriodMs: durationMs(check.start_period, 0),
    healthyThreshold: check.healthy_threshold ?? 1,
  };
}

function bounded(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new InvalidInputError('invalid_application_config', `The ${what} value is invalid.`);
  return value;
}
