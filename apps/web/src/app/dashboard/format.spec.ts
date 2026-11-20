import { deploymentStatus, leftLive, servingStatus } from './format';

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

describe('servingStatus', () => {
  it('follows the replicas once the latest deployment succeeded (#366)', () => {
    expect(servingStatus(0, 1).label).toBe('not running');
    expect(servingStatus(0, 0).label).toBe('not running');
    expect(servingStatus(1, 3).label).toBe('degraded');
    expect(servingStatus(3, 3).label).toBe('live');
  });
});
