import type { ShipkeepConfig } from '@shipkeep/config-schema';

import {
  containerName,
  containerPlan,
  cpuMillis,
  durationMs,
  environmentNetwork,
  resourceLimits,
  sizeBytes,
} from './container-plan';

/** One CPU and 512 MiB: what an application without `resources` runs under (#301). */
const DEFAULT_LIMITS = { cpuMillis: 1000, memoryBytes: 536_870_912 };

describe('resource and duration parsing', () => {
  it('reads cores, millicores, sizes and Go durations', () => {
    expect([cpuMillis('0.5'), cpuMillis('2'), cpuMillis('250m'), cpuMillis('0.29')]).toEqual([
      500, 2000, 250, 290,
    ]);
    // A positive amount below one millicore is one millicore, never "no limit".
    expect(cpuMillis('0.0004')).toBe(1);
    expect([sizeBytes('512Mi'), sizeBytes('1G'), sizeBytes('1024')]).toEqual([
      536_870_912, 1_000_000_000, 1024,
    ]);
    expect([
      durationMs('30s', 0),
      durationMs('1m30s', 0),
      durationMs('500ms', 0),
      durationMs(undefined, 7),
    ]).toEqual([30_000, 90_000, 500, 7]);
  });

  it('rejects malformed or unbounded values', () => {
    for (const parse of [
      () => cpuMillis('-1'),
      () => cpuMillis('1e3'),
      () => sizeBytes('1Pi'),
      () => sizeBytes(`${'9'.repeat(30)}Ti`),
      // Zero used to mean "no limit" (#301): it is refused, not read as unlimited.
      () => cpuMillis('0'),
      () => cpuMillis('0.000'),
      () => cpuMillis('0m'),
      () => sizeBytes('0'),
      () => sizeBytes('0Gi'),
      () => durationMs('1d', 0),
      () => durationMs('10 s', 0),
    ])
      expect(parse).toThrow(expect.objectContaining({ code: 'invalid_application_config' }));
  });
});

describe('resource limits', () => {
  const config = (resources?: ShipkeepConfig['resources']): ShipkeepConfig => ({
    version: 1,
    name: 'billing-api',
    build: { type: 'image', image: 'nginx' },
    run: { port: 80 },
    release: { command: ['migrate'] },
    ...(resources ? { resources } : {}),
  });

  it('gives an application without resources one CPU and 512 MiB', () => {
    expect(resourceLimits(config())).toEqual(DEFAULT_LIMITS);
    expect(resourceLimits(config({}))).toEqual(DEFAULT_LIMITS);
  });

  it('fills in the limit an application leaves out and keeps the one it declares', () => {
    expect(resourceLimits(config({ cpu: '250m' }))).toEqual({
      cpuMillis: 250,
      memoryBytes: 536_870_912,
    });
    expect(resourceLimits(config({ memory: '2Gi' }))).toEqual({
      cpuMillis: 1000,
      memoryBytes: 2 * 2 ** 30,
    });
    expect(resourceLimits(config({ cpu: '4', memory: '64Mi' }))).toEqual({
      cpuMillis: 4000,
      memoryBytes: 64 * 2 ** 20,
    });
  });

  it('never plans a replica or a release task without both limits', () => {
    for (const resources of [undefined, { cpu: '250m' }, { memory: '2Gi' }])
      for (const task of [false, true]) {
        const plan = containerPlan({
          config: config(resources),
          image: `nginx@sha256:${'c'.repeat(64)}`,
          name: 'sk-billing-api-0123456789ab-r1-0',
          network: 'sk-env-0190f5a87b1c7e2d8f3a0123456789ac',
          labels: {},
          task,
        });
        expect(plan).toMatchObject(resourceLimits(config(resources)));
        expect(plan.cpuMillis).toBeGreaterThan(0);
        expect(plan.memoryBytes).toBeGreaterThan(0);
      }
  });
});

describe('names', () => {
  it('fits the agent grammar for long application names', () => {
    const application = { id: '0190f5a8-7b1c-7e2d-8f3a-0123456789ab', name: 'a'.repeat(40) };
    for (const name of [
      containerName(application, 999_999, 99),
      containerName(application, 1, 'release'),
      environmentNetwork('0190f5a8-7b1c-7e2d-8f3a-0123456789ac'),
    ])
      expect(name).toMatch(/^sk-[a-z0-9-]{1,60}$/);
    expect(containerName(application, 3, 1)).toBe(`sk-${'a'.repeat(24)}-0123456789ab-r3-1`);
  });
});
