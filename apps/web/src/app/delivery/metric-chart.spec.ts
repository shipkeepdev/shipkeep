import { formatMetric, linePath, scaleTop, sumSeries } from './metric-chart';

describe('formatMetric', () => {
  it('writes each unit as the charts show it', () => {
    expect(formatMetric(0.042, 'cores')).toBe('42 mCPU');
    expect(formatMetric(1.5, 'cores')).toBe('1.50 CPU');
    expect(formatMetric(256 * 1024 ** 2, 'bytes')).toBe('256 MiB');
    expect(formatMetric(0, 'bytes')).toBe('0 MiB');
    expect(formatMetric(3.25, 'perSecond')).toBe('3.3/s');
    expect(formatMetric(42.4, 'perSecond')).toBe('42/s');
    expect(formatMetric(0.0123, 'seconds')).toBe('12 ms');
    expect(formatMetric(0.0006, 'seconds')).toBe('0.6 ms');
    expect(formatMetric(1.5, 'seconds')).toBe('1.50 s');
  });
});

describe('sumSeries', () => {
  it('adds series point by point, in time order, keeping times only one has', () => {
    expect(
      sumSeries([
        {
          points: [
            { t: 60, v: 1 },
            { t: 30, v: 2 },
          ],
        },
        {
          points: [
            { t: 30, v: 3 },
            { t: 90, v: 4 },
          ],
        },
      ]),
    ).toEqual([
      { t: 30, v: 5 },
      { t: 60, v: 1 },
      { t: 90, v: 4 },
    ]);
    expect(sumSeries([])).toEqual([]);
  });
});

describe('scaleTop', () => {
  it('is the largest value of every series, or 1 when nothing is above zero', () => {
    expect(scaleTop([[{ t: 0, v: 2 }], [{ t: 0, v: 7 }]])).toBe(7);
    expect(scaleTop([[{ t: 0, v: 0 }], []])).toBe(1);
    expect(scaleTop([])).toBe(1);
  });
});

describe('linePath', () => {
  it('draws the period left to right and the values bottom to top', () => {
    expect(
      linePath(
        [
          { t: 0, v: 0 },
          { t: 30, v: 5 },
          { t: 60, v: 10 },
        ],
        0,
        60,
        10,
        30,
      ),
    ).toBe('M0.00 100.00 L50.00 50.00 L100.00 0.00');
  });

  it('breaks the line over a gap of more than two steps, and clips values above the top', () => {
    expect(
      linePath(
        [
          { t: 0, v: 20 },
          { t: 30, v: 0 },
          { t: 120, v: 0 },
        ],
        0,
        120,
        10,
        30,
      ),
    ).toBe('M0.00 0.00 L25.00 100.00 M100.00 100.00');
  });

  it('draws nothing for no points, and survives an empty period', () => {
    expect(linePath([], 0, 60, 1, 30)).toBe('');
    expect(linePath([{ t: 5, v: 1 }], 5, 5, 1, 30)).toBe('M0.00 0.00');
  });
});
