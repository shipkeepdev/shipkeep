import type { OrganizationMetrics } from '../workspace/workspace-api';

import { areaPath, requestSteps, roundTop } from './requests-chart';

const metrics: OrganizationMetrics = {
  kept: true,
  range: '24h',
  stepSeconds: 300,
  from: '2026-11-20T00:00:00Z',
  to: '2026-11-21T00:00:00Z',
  requests: [
    {
      labels: { status: '2xx' },
      points: [
        { t: 600, v: 2 },
        { t: 300, v: 1 },
      ],
    },
    { labels: { status: '5xx' }, points: [{ t: 600, v: 0.5 }] },
  ],
  totalRequests: 1050,
  meanSeconds: 0.0314,
  duration: [
    {
      labels: {},
      points: [
        { t: 300, v: 0.01 },
        { t: 600, v: 0.04 },
      ],
    },
  ],
};

describe('requests chart', () => {
  it('adds every status class step by step and keeps the 5xx apart', () => {
    expect(requestSteps(metrics)).toEqual([
      { t: 300, requests: 1, errors: 0 },
      { t: 600, requests: 2.5, errors: 0.5 },
    ]);
  });

  it('rounds the top of the scale to 1, 2 or 5 times a power of ten', () => {
    expect(roundTop(0)).toBe(1);
    expect(roundTop(3.2)).toBe(5);
    expect(roundTop(180)).toBe(200);
    expect(roundTop(1000)).toBe(1000);
    expect(roundTop(1001)).toBe(2000);
  });

  it('closes one area per run of points and leaves a gap empty', () => {
    expect(
      areaPath(
        [
          { t: 0, v: 10 },
          { t: 30, v: 5 },
          { t: 120, v: 10 },
        ],
        0,
        120,
        10,
        30,
      ),
    ).toBe('M0.00 100 L0.00 0.00 L25.00 50.00 L25.00 100 Z M100.00 100 L100.00 0.00 L100.00 100 Z');
    expect(areaPath([], 0, 60, 1, 30)).toBe('');
  });
});
