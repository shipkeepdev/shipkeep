import { parseMatrix } from './victoria-metrics.store';

describe('parseMatrix', () => {
  it('reads the series of a range query and skips any point it cannot read', () => {
    expect(
      parseMatrix({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { status: '2xx' },
              values: [
                [1795000000, '1.5'],
                [1795000030, 'NaN'],
                ['x', '2'],
              ],
            },
          ],
        },
      }),
    ).toEqual([{ labels: { status: '2xx' }, points: [[1795000000, 1.5]] }]);
    expect(parseMatrix({ status: 'error' })).toEqual([]);
    expect(parseMatrix('<html>')).toEqual([]);
  });
});
