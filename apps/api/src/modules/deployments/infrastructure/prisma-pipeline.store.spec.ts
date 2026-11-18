import { outcome } from './prisma-pipeline.store';

describe('pipeline step outcomes', () => {
  it('reads proto JSON results, filling omitted defaults', () => {
    expect(outcome({ state: 'succeeded', result: { containerId: 'abc' }, error: null })).toEqual({
      state: 'succeeded',
      reason: null,
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
      reason: 'unknown',
    });
    expect(
      outcome({ state: 'running', result: { containerId: 42, healthCheck: 'yes' }, error: null }),
    ).toEqual({ state: 'running', reason: null });
  });

  it('keeps the reason of an unsuccessful action, never the text the agent sent', () => {
    expect(
      outcome({ state: 'compensated', result: null, error: 'registry refused the pull' }),
    ).toEqual({ state: 'compensated', reason: 'registry_denied' });
    expect(outcome({ state: 'failed', result: null, error: 'invalid action input' })).toEqual({
      state: 'failed',
      reason: 'invalid_input',
    });
    expect(outcome({ state: 'failed', result: null, error: null })).toEqual({
      state: 'failed',
      reason: 'action_failed',
    });
    const hostile = outcome({
      state: 'compensated',
      result: null,
      error: 'pull failed: https://deploy:sk_test_fake_registry_password@registry.example.com',
    });
    expect(hostile).toEqual({ state: 'compensated', reason: 'unknown' });
    expect(JSON.stringify(hostile)).not.toContain('sk_test_fake');
  });
});
