import type { Deployment } from './delivery-api';
import { startTarget } from './start-target';

const deployment = (id: string, state: string, stop: boolean): Deployment =>
  ({ id, state, stop, releaseId: `r-${id}` }) as unknown as Deployment;

describe('startTarget', () => {
  it('is the stop when the latest success stopped the application', () => {
    const history = [
      deployment('failed-after', 'failed', false),
      deployment('stop', 'succeeded', true),
      deployment('ran', 'succeeded', false),
    ];
    expect(startTarget(history)?.id).toBe('stop');
  });

  it('does not need the deployment that ran before the stop', () => {
    expect(startTarget([deployment('stop', 'succeeded', true)])?.id).toBe('stop');
  });

  it('is nothing while a version serves, or when nothing succeeded', () => {
    expect(
      startTarget([deployment('ran', 'succeeded', false), deployment('stop', 'succeeded', true)]),
    ).toBeNull();
    expect(startTarget([deployment('queued', 'queued', true)])).toBeNull();
    expect(startTarget([])).toBeNull();
  });
});
