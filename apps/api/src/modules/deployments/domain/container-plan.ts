import {
  cpuMillicores,
  DEFAULT_RESOURCES,
  durationInMs,
  type ShipkeepConfig,
  sizeInBytes,
} from '@shipkeep/config-schema';
import { InvalidInputError, type Resources } from '@shipkeep/domain';

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

/** `0.5` or `500m` (SPEC 2) as whole millicores, at least one. Zero is refused, not unlimited. */
export function cpuMillis(value: string): number {
  const amount = cpuMillicores(value);
  // A positive amount below one millicore is one millicore: rounding must not remove the limit.
  return positive(amount > 0 ? Math.max(1, Math.round(amount)) : amount, 'cpu');
}

/** Kubernetes-style size (`512Mi`, `2G`, bare bytes) as bytes. Zero is refused, not unlimited. */
export function sizeBytes(value: string): number {
  return positive(sizeInBytes(value), 'memory');
}

/**
 * The CPU and memory limit of each container of the application: what `resources` declares, and
 * `DEFAULT_RESOURCES` (one CPU, 512 MiB) for what it leaves out. A container never runs without
 * both, so one application cannot starve the others on its node. Placement reserves exactly
 * these values, the allocation records them and the agent enforces them.
 */
export function resourceLimits(config: ShipkeepConfig): Resources {
  return {
    cpuMillis: cpuMillis(config.resources?.cpu ?? DEFAULT_RESOURCES.cpu),
    memoryBytes: sizeBytes(config.resources?.memory ?? DEFAULT_RESOURCES.memory),
  };
}

/** Go-style duration (`30s`, `1m30s`, `500ms`) in milliseconds. */
export function durationMs(value: string | undefined, fallback: number): number {
  return value === undefined ? fallback : bounded(durationInMs(value), 'duration');
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
    ...resourceLimits(config),
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

function positive(value: number, what: string): number {
  if (bounded(value, what) === 0)
    throw new InvalidInputError(
      'invalid_application_config',
      `The ${what} limit must be greater than zero.`,
    );
  return value;
}
