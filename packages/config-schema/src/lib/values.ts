import type { ShipkeepConfig } from '../gen/shipkeep-config.js';

import type { ConfigIssue } from './validate.js';

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

/**
 * What the control plane can deploy (SPEC 2.2). The agent refuses a container above 256 CPUs or
 * 1 TiB, and Docker refuses a memory limit below 6 MiB. A disk budget is between 64 MiB and 1 TiB
 * (ADR 0022). `lib/config` holds the same numbers for
 * the Go validator; the shared fixtures keep the two in step.
 */
export const RESOURCE_RANGE = {
  maxCpuMillis: 256_000,
  minMemoryBytes: 6 * 2 ** 20,
  maxMemoryBytes: 2 ** 40,
  minDiskBytes: 64 * 2 ** 20,
  maxDiskBytes: 2 ** 40,
} as const;

/** `0.5` or `500m` as millicores, which may be a fraction; NaN when it is not a CPU amount. */
export function cpuMillicores(text: string): number {
  const millis = /^([0-9]+)m$/.exec(text);
  const cores = /^([0-9]+(?:\.[0-9]+)?)$/.exec(text);
  return millis?.[1] ? Number(millis[1]) : cores?.[1] ? Number(cores[1]) * 1000 : NaN;
}

/** Kubernetes-style size (`512Mi`, `2G`, bare bytes) as bytes; NaN when it is not a size. */
export function sizeInBytes(text: string): number {
  const match = /^([0-9]+)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(text);
  const unit = SIZE_UNITS[match?.[2] ?? ''];
  return match?.[1] && unit ? Number(match[1]) * unit : NaN;
}

/** Go-style duration (`30s`, `1m30s`, `500ms`) in milliseconds; NaN when it is not a duration. */
export function durationInMs(text: string): number {
  if (!/^([0-9]+(ms|s|m|h))+$/.test(text)) return NaN;
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/([0-9]+)(ms|s|m|h)/g))
    total += Number(amount) * (DURATION_UNITS.get(unit) ?? NaN);
  return total;
}

/**
 * Problems the schema cannot express: values that are well formed and that the control plane
 * could never deploy. Refusing them when a configuration is saved is better than failing every
 * deployment of it later.
 */
export function valueIssues(config: ShipkeepConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const { cpu, memory, disk } = config.resources ?? {};
  if (cpu !== undefined) {
    const millis = cpuMillicores(cpu);
    if (!(millis > 0 && millis <= RESOURCE_RANGE.maxCpuMillis))
      issues.push({ path: '/resources/cpu', message: 'must be at most 256 CPUs' });
  }
  if (memory !== undefined) {
    const bytes = sizeInBytes(memory);
    if (!(bytes >= RESOURCE_RANGE.minMemoryBytes && bytes <= RESOURCE_RANGE.maxMemoryBytes))
      issues.push({ path: '/resources/memory', message: 'must be between 6Mi and 1Ti' });
  }
  if (disk !== undefined) {
    const bytes = sizeInBytes(disk);
    if (!(bytes >= RESOURCE_RANGE.minDiskBytes && bytes <= RESOURCE_RANGE.maxDiskBytes))
      issues.push({ path: '/resources/disk', message: 'must be between 64Mi and 1Ti' });
  }
  // Every duration the deployment pipeline reads. A value it cannot count would fail there.
  const check = config.run?.healthcheck;
  const durations: readonly (readonly [string, string | undefined])[] = [
    ['/run/healthcheck/interval', check?.interval],
    ['/run/healthcheck/timeout', check?.timeout],
    ['/run/healthcheck/start_period', check?.start_period],
    ['/release/timeout', config.release?.timeout],
    ['/deploy/drain_timeout', config.deploy?.drain_timeout],
  ];
  for (const [path, value] of durations)
    if (value !== undefined && !Number.isSafeInteger(durationInMs(value)))
      issues.push({ path, message: 'is too long to be counted' });
  return issues;
}
