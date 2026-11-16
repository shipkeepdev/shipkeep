import type { ShipkeepConfig } from '../gen/shipkeep-config.js';

import { validateShipkeepConfig } from './validate.js';
import { cpuMillicores, durationInMs, sizeInBytes, valueIssues } from './values.js';

const base: ShipkeepConfig = {
  version: 1,
  name: 'api',
  build: { type: 'image', image: 'nginx' },
  run: { port: 80 },
};

describe('reading shipkeep.yml values', () => {
  it('reads cores and millicores', () => {
    expect([cpuMillicores('0.5'), cpuMillicores('2'), cpuMillicores('250m')]).toEqual([
      500, 2000, 250,
    ]);
    expect(cpuMillicores('0.0004')).toBeCloseTo(0.4);
    expect([cpuMillicores('half'), cpuMillicores('-1'), cpuMillicores('1e3')]).toEqual([
      NaN,
      NaN,
      NaN,
    ]);
  });

  it('reads sizes in decimal and binary units', () => {
    expect([sizeInBytes('512Mi'), sizeInBytes('1G'), sizeInBytes('1024')]).toEqual([
      536_870_912, 1_000_000_000, 1024,
    ]);
    expect([sizeInBytes('1Pi'), sizeInBytes('512MB')]).toEqual([NaN, NaN]);
  });

  it('reads Go-style durations', () => {
    expect([durationInMs('30s'), durationInMs('1m30s'), durationInMs('500ms')]).toEqual([
      30_000, 90_000, 500,
    ]);
    expect([durationInMs('1d'), durationInMs('10 s')]).toEqual([NaN, NaN]);
  });
});

describe('valueIssues', () => {
  const issues = (extra: Partial<ShipkeepConfig>) => valueIssues({ ...base, ...extra });

  it('accepts a configuration without resources and one at each limit', () => {
    expect(issues({})).toEqual([]);
    expect(issues({ resources: { cpu: '1m', memory: '6Mi' } })).toEqual([]);
    expect(issues({ resources: { cpu: '256', memory: '1Ti' } })).toEqual([]);
    expect(issues({ resources: { cpu: '256000m', memory: '6291456' } })).toEqual([]);
  });

  it('refuses a CPU limit the agent would refuse, or that cannot be counted', () => {
    for (const cpu of ['257', '256001m', '256.001', '9999999999999999'])
      expect(issues({ resources: { cpu } })).toEqual([
        { path: '/resources/cpu', message: 'must be at most 256 CPUs' },
      ]);
  });

  it('refuses memory below what Docker accepts or above what the agent accepts', () => {
    for (const memory of ['5Mi', '6291455', '6M', '2Ti', `${'9'.repeat(30)}Ti`])
      expect(issues({ resources: { cpu: '1', memory } })).toEqual([
        { path: '/resources/memory', message: 'must be between 6Mi and 1Ti' },
      ]);
  });

  it('refuses every duration the pipeline reads when it cannot be counted', () => {
    const endless = `${'9'.repeat(29)}h`;
    expect(
      issues({
        run: {
          port: 80,
          healthcheck: { path: '/', interval: endless, timeout: endless, start_period: endless },
        },
        release: { command: ['migrate'], timeout: endless },
        deploy: { drain_timeout: endless },
      }).map((issue) => issue.path),
    ).toEqual([
      '/run/healthcheck/interval',
      '/run/healthcheck/timeout',
      '/run/healthcheck/start_period',
      '/release/timeout',
      '/deploy/drain_timeout',
    ]);
    expect(issues({ run: { port: 80, healthcheck: { path: '/', interval: '720h' } } })).toEqual([]);
  });

  it('is part of the validation every consumer runs', () => {
    expect(validateShipkeepConfig({ ...base, resources: { memory: '5Mi' } })).toEqual({
      ok: false,
      issues: [{ path: '/resources/memory', message: 'must be between 6Mi and 1Ti' }],
    });
    expect(validateShipkeepConfig({ ...base, resources: { memory: '6Mi' } }).ok).toBe(true);
  });
});
