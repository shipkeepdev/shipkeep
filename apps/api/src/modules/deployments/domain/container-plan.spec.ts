import {
  containerName,
  cpuMillis,
  durationMs,
  environmentNetwork,
  sizeBytes,
} from './container-plan';

describe('resource and duration parsing', () => {
  it('reads cores, millicores, sizes and Go durations', () => {
    expect([cpuMillis('0.5'), cpuMillis('2'), cpuMillis('250m'), cpuMillis(undefined)]).toEqual([
      500, 2000, 250, 0,
    ]);
    expect([sizeBytes('512Mi'), sizeBytes('1G'), sizeBytes('1024'), sizeBytes(undefined)]).toEqual([
      536_870_912, 1_000_000_000, 1024, 0,
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
      () => durationMs('1d', 0),
      () => durationMs('10 s', 0),
    ])
      expect(parse).toThrow(expect.objectContaining({ code: 'invalid_application_config' }));
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
