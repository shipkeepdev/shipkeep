import {
  advance,
  allowedTransitions,
  type Deployment,
  DEPLOYMENT_STATES,
  type DeploymentState,
  isActive,
  nextState,
  rollBack,
  stop,
} from './deployment.js';

const now = new Date('2026-11-05T12:00:00Z');
const plans = [
  { build: true, release: true },
  { build: true, release: false },
  { build: false, release: true },
  { build: false, release: false },
];
function deployment(
  state: DeploymentState,
  plan: Deployment['plan'] = plans[0] ?? { build: true, release: true },
): Deployment {
  return { id: 'd', state, plan, startedAt: now, finishedAt: null, error: null };
}
function walk(plan: Deployment['plan']): DeploymentState[] {
  const states: DeploymentState[] = ['queued'];
  let current = deployment('queued', plan);
  while (current.state !== 'succeeded') {
    current = advance(current, now);
    states.push(current.state);
  }
  return states;
}

describe('SPEC 5.1 deployment state machine', () => {
  it('runs the full pipeline and skips only the stages a plan does not need', () => {
    expect(walk({ build: true, release: true })).toEqual([
      'queued',
      'building',
      'built',
      'releasing',
      'scheduling',
      'starting',
      'health_checking',
      'switching',
      'draining',
      'succeeded',
    ]);
    expect(walk({ build: false, release: false })).toEqual([
      'queued',
      'scheduling',
      'starting',
      'health_checking',
      'switching',
      'draining',
      'succeeded',
    ]);
    expect(walk({ build: true, release: false })).not.toContain('releasing');
    expect(walk({ build: false, release: true })).toEqual(
      expect.not.arrayContaining(['building', 'built']),
    );
  });

  it('only drains for a stop: nothing is built, released, placed or started', () => {
    expect(walk({ build: false, release: false, stop: true })).toEqual([
      'queued',
      'draining',
      'succeeded',
    ]);
    // A stop never builds or runs a release command, whatever the rest of the plan says.
    expect(walk({ build: true, release: true, stop: true })).toEqual([
      'queued',
      'draining',
      'succeeded',
    ]);
    const stopping = deployment('queued', { build: false, release: false, stop: true });
    // Cancelled before it started draining, a stop has changed nothing.
    expect(stop(stopping, 'cancelled', null, now).routing).toBe('untouched');
    expect(advance(advance(stopping, now), now)).toMatchObject({
      state: 'succeeded',
      finishedAt: now,
    });
  });

  it('only switches routes to enter or leave maintenance (ADR 0025)', () => {
    for (const maintenance of ['enter', 'leave'] as const) {
      expect(walk({ build: false, release: false, maintenance })).toEqual([
        'queued',
        'switching',
        'succeeded',
      ]);
      // Nothing is built, released, placed, started or drained, whatever the rest of the plan says.
      expect(walk({ build: true, release: true, maintenance })).toEqual([
        'queued',
        'switching',
        'succeeded',
      ]);
      const changing = deployment('queued', { build: false, release: false, maintenance });
      expect(stop(changing, 'cancelled', null, now).routing).toBe('untouched');
      // Interrupted while it switches, the routes go back to what they served.
      expect(stop(advance(changing, now), 'failed', 'x', now).routing).toBe('restore_previous');
    }
  });

  it('never advances a finished deployment and only rolls back a succeeded one', () => {
    for (const state of ['succeeded', 'failed', 'cancelled', 'rolled_back'] as const) {
      expect(() => advance(deployment(state), now)).toThrow('cannot advance');
      expect(isActive(state)).toBe(false);
      if (state !== 'succeeded')
        expect(() => rollBack(deployment(state))).toThrow('cannot roll back');
    }
    expect(rollBack(deployment('succeeded')).state).toBe('rolled_back');
  });

  it('keeps the previous release serving on any failure before draining', () => {
    for (const state of DEPLOYMENT_STATES) {
      const current = deployment(state);
      if (!isActive(state)) {
        expect(() => stop(current, 'failed', 'x', now)).toThrow();
        continue;
      }
      for (const outcome of ['failed', 'cancelled'] as const) {
        const result = stop(current, outcome, 'pull failed', now);
        expect(result.deployment).toMatchObject({
          state: outcome,
          finishedAt: now,
          error: 'pull failed',
        });
        expect(result.routing).toBe(
          state === 'switching'
            ? 'restore_previous'
            : state === 'draining'
              ? 'new_release_serving'
              : 'untouched',
        );
      }
    }
  });

  it('allows exactly the SPEC transitions from every state', () => {
    for (const from of DEPLOYMENT_STATES)
      for (const to of DEPLOYMENT_STATES) {
        const allowed = allowedTransitions(from).includes(to);
        const finished = ['succeeded', 'failed', 'cancelled', 'rolled_back'].includes(from);
        const expected =
          from === 'succeeded'
            ? to === 'rolled_back'
            : !finished &&
              to !== from &&
              (to === 'failed' ||
                to === 'cancelled' ||
                (DEPLOYMENT_STATES.indexOf(to) > DEPLOYMENT_STATES.indexOf(from) &&
                  DEPLOYMENT_STATES.indexOf(to) <= DEPLOYMENT_STATES.indexOf('succeeded')));
        expect(allowed, `${from} -> ${to}`).toBe(expected);
      }
    for (const plan of plans)
      for (const state of DEPLOYMENT_STATES.filter(isActive))
        expect(allowedTransitions(state)).toContain(nextState(state, plan));
  });

  it('bounds failure reasons and strips control characters', () => {
    const { deployment: failed } = stop(
      deployment('starting'),
      'failed',
      `bad\n${'x'.repeat(600)}\u0000`,
      now,
    );
    expect(failed.error?.length).toBe(512);
    expect(failed.error?.includes('\n') || failed.error?.includes('\u0000')).toBe(false);
    expect(() => stop(deployment('starting'), 'failed', ' \n ', now)).toThrow('needs a reason');
    expect(stop(deployment('queued'), 'cancelled', null, now).deployment.error).toBeNull();
  });
});
