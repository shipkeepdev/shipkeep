import { deploymentStatus, leftLive } from './format';

describe('deployment status', () => {
  it('names a stop for what it does to the application', () => {
    expect(deploymentStatus('succeeded').label).toBe('live');
    expect(deploymentStatus('succeeded', true).label).toBe('stopped');
    for (const state of ['queued', 'draining'] as const)
      expect(deploymentStatus(state, true).label).toBe('stopping');
    // A stop that did not finish stopped nothing for sure: it reads like any other failure.
    expect(deploymentStatus('failed', true).label).toBe('failed');
    expect(deploymentStatus('cancelled', true).label).toBe('cancelled');
  });

  it('counts an application as live only when its last deployment started it', () => {
    expect(leftLive({ state: 'succeeded', stop: false })).toBe(true);
    expect(leftLive({ state: 'succeeded', stop: true })).toBe(false);
    expect(leftLive({ state: 'failed', stop: false })).toBe(false);
    expect(leftLive(undefined)).toBe(false);
  });
});
