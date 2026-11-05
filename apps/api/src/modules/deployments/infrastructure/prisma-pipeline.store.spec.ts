import { outcome } from './prisma-pipeline.store';

describe('pipeline step outcomes', () => {
  it('reads proto JSON results, filling omitted defaults', () => {
    expect(outcome({ state: 'succeeded', result: { containerId: 'abc' }, error: null })).toEqual({
      state: 'succeeded',
      error: null,
      containerId: 'abc',
    });
    expect(outcome({ state: 'succeeded', result: { releaseTask: {} }, error: null })).toMatchObject(
      {
        exitCode: 0,
      },
    );
    expect(
      outcome({ state: 'succeeded', result: { releaseTask: { exitCode: 2 } }, error: null }),
    ).toMatchObject({ exitCode: 2 });
    expect(outcome({ state: 'succeeded', result: { healthCheck: {} }, error: null })).toMatchObject(
      {
        healthy: false,
      },
    );
    expect(
      outcome({ state: 'succeeded', result: { healthCheck: { healthy: true } }, error: null }),
    ).toMatchObject({ healthy: true });
  });

  it('treats unknown states and malformed results conservatively', () => {
    expect(outcome({ state: 'exploded', result: 'not-an-object', error: 'x' })).toEqual({
      state: 'failed',
      error: 'x',
    });
    expect(
      outcome({ state: 'running', result: { containerId: 42, healthCheck: 'yes' }, error: null }),
    ).toEqual({ state: 'running', error: null });
  });
});
