import { type AgentAction, type Deployment, type DeploymentTimeline } from './delivery-api';
import { deploymentView, stepDuration, timelineEnded } from './deployment-view';

const at = (second: number) => new Date(Date.UTC(2026, 10, 22, 10, 0, second)).toISOString();
const deployment: Deployment = {
  id: 'd1',
  releaseId: '4f2c1a9e0000',
  state: 'failed',
  build: false,
  release: false,
  stop: false,
  trigger: 'manual',
  actorId: null,
  error: 'The image could not be pulled.',
  startedAt: at(0),
  finishedAt: at(40),
};
const action = (id: string, second: number, extra: Partial<AgentAction> = {}): AgentAction => ({
  id,
  nodeId: 'n1',
  nodeName: 'edge-1',
  kind: 'pullImage',
  state: 'failed',
  outcome: 'failed',
  reason: 'image_not_found',
  step: '',
  attempts: 1,
  result: null,
  deploymentId: 'd1',
  createdAt: at(second),
  updatedAt: at(second),
  completedAt: at(second),
  ...extra,
});
const timeline: DeploymentTimeline = {
  steps: [
    { from: null, to: 'queued', at: at(0), reason: null },
    { from: 'queued', to: 'scheduling', at: at(0.4), reason: null },
    { from: 'scheduling', to: 'starting', at: at(2), reason: null },
    { from: 'starting', to: 'failed', at: at(40), reason: 'The image could not be pulled.' },
  ],
  actions: [action('x1', 2)],
  truncated: false,
};

describe('deployment view (#265)', () => {
  it('times each step and colours the one it failed in', () => {
    const view = deploymentView(deployment, timeline, Date.parse(at(60)));
    expect(view.finished).toBe(true);
    expect(view.status).toEqual({ label: 'failed', color: 'oklch(0.68 0.17 25)' });
    expect(view.stats.map((s) => [s.label, s.duration, s.color])).toEqual([
      ['Queued', { t: '< 1 s' }, undefined],
      ['Placement', { t: '{n} s', values: { n: 2 } }, undefined],
      ['Starting', { t: '{n} s', values: { n: 38 } }, 'oklch(0.68 0.17 25)'],
    ]);
  });

  it('puts steps and agent actions in one timeline, steps first at the same instant', () => {
    const view = deploymentView(deployment, timeline);
    expect(view.lines.map((line) => line.parts.map((part) => part.t))).toEqual([
      ['Deployment queued'],
      ['Placement'],
      ['Starting'],
      ['{action} → {server}', 'failed', 'image not found'],
      ['failed', 'The image could not be pulled.'],
    ]);
    expect(view.lines[3]?.parts[0]?.values).toEqual({ action: 'PullImage', server: 'edge-1' });
    expect(view.lines[3]?.color).toBe('oklch(0.68 0.17 25)');
  });

  it('shows the step a running deployment is in, counting up to now', () => {
    const running = { ...deployment, state: 'starting' as const, error: null, finishedAt: null };
    const view = deploymentView(
      running,
      { ...timeline, steps: timeline.steps.slice(0, 3), actions: [] },
      Date.parse(at(17)),
    );
    expect(view.finished).toBe(false);
    expect(view.stats.at(-1)).toMatchObject({
      label: 'Starting',
      duration: { t: '{n} s', values: { n: 15 } },
      color: 'oklch(0.72 0.13 250)',
    });
  });

  it('names a stop as such', () => {
    const view = deploymentView({ ...deployment, stop: true }, timeline);
    expect(view.lines[0]?.parts).toEqual([{ t: 'Stop queued' }]);
  });

  it('ends a stop that succeeded as stopped, as the header does', () => {
    const steps = [
      { from: null, to: 'queued' as const, at: at(0), reason: null },
      { from: 'queued' as const, to: 'succeeded' as const, at: at(3), reason: null },
    ];
    const stopped = deploymentView(
      { ...deployment, stop: true, state: 'succeeded', error: null, finishedAt: at(3) },
      { steps, actions: [], truncated: false },
    );
    expect(stopped.status.label).toBe('stopped');
    expect(stopped.lines.at(-1)?.parts).toEqual([{ t: 'stopped' }]);
    // An ordinary deployment that succeeded is live; a stop that failed stays failed.
    const live = deploymentView(
      { ...deployment, state: 'succeeded', error: null, finishedAt: at(3) },
      { steps, actions: [], truncated: false },
    );
    expect(live.lines.at(-1)?.parts).toEqual([{ t: 'live' }]);
    expect(deploymentView({ ...deployment, stop: true }, timeline).lines.at(-1)?.parts).toEqual([
      { t: 'failed' },
      { t: 'The image could not be pulled.' },
    ]);
  });

  it('knows when the timeline holds the step the deployment ended with', () => {
    expect(timelineEnded(deployment, timeline)).toBe(true);
    // Read side by side, the timeline can still miss it.
    expect(timelineEnded(deployment, { ...timeline, steps: timeline.steps.slice(0, 3) })).toBe(
      false,
    );
    expect(timelineEnded({ ...deployment, state: 'starting', finishedAt: null }, timeline)).toBe(
      false,
    );
  });

  it('writes durations in whole units', () => {
    expect(stepDuration(800)).toEqual({ t: '< 1 s' });
    expect(stepDuration(99_000)).toEqual({ t: '{n} s', values: { n: 99 } });
    expect(stepDuration(150_000)).toEqual({ t: '{n} min', values: { n: 3 } });
    expect(stepDuration(65 * 60_000)).toEqual({ t: '{h} h {m} min', values: { h: 1, m: 5 } });
  });
});
