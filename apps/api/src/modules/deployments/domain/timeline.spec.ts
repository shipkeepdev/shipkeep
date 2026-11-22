import { deploymentSteps } from './timeline';

const at = (second: number) => new Date(Date.UTC(2026, 10, 22, 10, 0, second));

describe('deployment steps from audited events (#265)', () => {
  it('reads the pipeline in order, with where each step came from', () => {
    expect(
      deploymentSteps([
        { action: 'deployment.queued', metadata: { trigger: 'manual' }, at: at(0) },
        {
          action: 'deployment.advanced',
          metadata: { from: 'queued', to: 'scheduling' },
          at: at(1),
        },
        {
          action: 'deployment.advanced',
          metadata: { from: 'scheduling', to: 'starting' },
          at: at(3),
        },
        {
          action: 'deployment.failed',
          metadata: {
            from: 'starting',
            reason: 'Image pull refused.',
            routing: 'previous_release_serving',
          },
          at: at(9),
        },
      ]),
    ).toEqual([
      { from: null, to: 'queued', at: at(0), reason: null },
      { from: 'queued', to: 'scheduling', at: at(1), reason: null },
      { from: 'scheduling', to: 'starting', at: at(3), reason: null },
      { from: 'starting', to: 'failed', at: at(9), reason: 'Image pull refused.' },
    ]);
  });

  it('reads a cancel and a superseding rollback', () => {
    expect(
      deploymentSteps([
        { action: 'deployment.cancelled', metadata: { from: 'queued' }, at: at(2) },
        { action: 'deployment.rolled_back', metadata: { rollback: 'x' }, at: at(5) },
      ]).map((step) => [step.from, step.to]),
    ).toEqual([
      ['queued', 'cancelled'],
      [null, 'rolled_back'],
    ]);
  });

  it('leaves out what it cannot read instead of guessing', () => {
    expect(
      deploymentSteps([
        { action: 'deployment.advanced', metadata: { from: 'queued', to: 'exploded' }, at: at(1) },
        { action: 'deployment.advanced', metadata: null, at: at(2) },
        { action: 'release.created', metadata: {}, at: at(3) },
        { action: 'deployment.advanced', metadata: { from: 42, to: 'draining' }, at: at(4) },
      ]),
    ).toEqual([{ from: null, to: 'draining', at: at(4), reason: null }]);
  });

  it('keeps a failure reason short and drops an empty one', () => {
    const [long, empty] = deploymentSteps([
      { action: 'deployment.failed', metadata: { reason: 'x'.repeat(2000) }, at: at(1) },
      { action: 'deployment.failed', metadata: { reason: '' }, at: at(2) },
    ]);
    expect(long.reason).toHaveLength(512);
    expect(empty.reason).toBeNull();
  });
});
