import {
  type ObservedAllocation,
  observationChanges,
  type ReportedContainer,
} from './observations';

const NOW = new Date('2026-11-07T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const allocation = (observation: ObservedAllocation['observation']): ObservedAllocation => ({
  id: 'a1',
  applicationId: 'app',
  container: 'sk-web-1',
  observation,
});
const running: ReportedContainer = {
  containerId: 'f'.repeat(64),
  name: 'sk-web-1',
  state: 'running',
};

describe('observationChanges', () => {
  it('records the first sighting and real changes', () => {
    expect(observationChanges([allocation(null)], [running], NOW)).toEqual([
      {
        allocationId: 'a1',
        applicationId: 'app',
        container: 'sk-web-1',
        containerId: running.containerId,
        state: 'running',
        from: null,
        changed: true,
      },
    ]);
    const stopped = { ...running, state: 'exited' as const };
    expect(
      observationChanges([allocation({ state: 'running', observedAt: ago(1000) })], [stopped], NOW),
    ).toMatchObject([{ state: 'exited', from: 'running', changed: true }]);
  });

  it('marks a seen container missing, but not one that was never created', () => {
    expect(observationChanges([allocation(null)], [], NOW)).toEqual([]);
    expect(
      observationChanges([allocation({ state: 'running', observedAt: ago(1000) })], [], NOW),
    ).toMatchObject([{ state: 'missing', from: 'running', containerId: null, changed: true }]);
  });

  it('writes nothing for an unchanged state until the refresh interval', () => {
    const current = allocation({ state: 'running', observedAt: ago(59_999) });
    expect(observationChanges([current], [running], NOW)).toEqual([]);
    const stale = allocation({ state: 'running', observedAt: ago(60_000) });
    expect(observationChanges([stale], [running], NOW)).toMatchObject([
      { state: 'running', from: 'running', changed: false },
    ]);
  });

  it('ignores reported containers that match no replica of this node', () => {
    const foreign = { ...running, name: 'sk-other-node' };
    expect(observationChanges([allocation(null)], [foreign], NOW)).toEqual([]);
    expect(observationChanges([], [running], NOW)).toEqual([]);
  });
});
