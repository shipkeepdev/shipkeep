import { BLUE, deploymentStatus, RED, type Status } from '../dashboard/format';
import { type IconName } from '../shell/icons';

import { agentActionRow, timestamp } from './agent-action-rows';
import { type Deployment, type DeploymentTimeline } from './delivery-api';

/** English source text and its values, translated by the page. */
export interface Text {
  readonly t: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

/** How long the deployment stayed in one step of its pipeline. */
export interface StepStat {
  readonly icon: IconName;
  readonly label: string;
  readonly duration: Text;
  /** When it entered the step, dd/MM HH:mm:ss; the timeline's lines give the time alone. */
  readonly at: string;
  readonly color?: string;
}

/** One line of the timeline: a step the deployment entered, or an action it asked an agent for. */
export interface TimelineLine {
  readonly key: string;
  readonly at: string;
  readonly parts: readonly Text[];
  readonly color?: string;
}

export interface DeploymentView {
  readonly status: Status;
  readonly stats: readonly StepStat[];
  readonly lines: readonly TimelineLine[];
  readonly truncated: boolean;
  readonly finished: boolean;
}

const STEPS: Readonly<Partial<Record<Deployment['state'], { label: string; icon: IconName }>>> = {
  queued: { label: 'Queued', icon: 'clock' },
  building: { label: 'Build', icon: 'hammer' },
  releasing: { label: 'Release command', icon: 'database' },
  scheduling: { label: 'Placement', icon: 'route' },
  starting: { label: 'Starting', icon: 'player-play' },
  health_checking: { label: 'Health check', icon: 'heartbeat' },
  switching: { label: 'Switchover', icon: 'arrows-exchange' },
  draining: { label: 'Draining', icon: 'player-pause' },
};

/** The states a deployment ends in; the timeline names them as the header does. */
const ENDINGS: ReadonlySet<Deployment['state']> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'rolled_back',
]);

/**
 * Whether the timeline already holds the step a finished deployment ended with. The page reads
 * the deployment and its timeline side by side, so the timeline can lag one step behind.
 */
export function timelineEnded(deployment: Deployment, timeline: DeploymentTimeline): boolean {
  return deployment.finishedAt !== null && timeline.steps.at(-1)?.to === deployment.state;
}

/** One deployment's page from what it went through (#265). Pure. */
export function deploymentView(
  deployment: Deployment,
  timeline: DeploymentTimeline,
  now = Date.now(),
): DeploymentView {
  const finished = deployment.finishedAt !== null;
  const end = deployment.finishedAt ? Date.parse(deployment.finishedAt) : now;
  const steps = timeline.steps;
  const stats: StepStat[] = [];
  steps.forEach((step, index) => {
    const known = STEPS[step.to];
    if (!known) return;
    const next = steps.at(index + 1);
    const until = next ? Date.parse(next.at) : end;
    const running = !next && !finished;
    stats.push({
      icon: known.icon,
      label: known.label,
      duration: stepDuration(until - Date.parse(step.at)),
      at: timestamp(step.at),
      color: running ? BLUE : undefined,
    });
  });
  // The step it failed in reads red.
  const last = stats.at(-1);
  if (deployment.state === 'failed' && last) stats[stats.length - 1] = { ...last, color: RED };

  // Steps first, then actions, in their own order, when two share an instant.
  const lines: (TimelineLine & { order: number })[] = [
    ...steps.map((step, index): TimelineLine & { order: number } => {
      // A stop that succeeded is "stopped", not "live", as the header says.
      const ending = ENDINGS.has(step.to) ? deploymentStatus(step.to, deployment.stop) : null;
      if (ending)
        return {
          key: `s${String(index)}`,
          order: index,
          at: step.at,
          parts: step.reason ? [{ t: ending.label }, { t: step.reason }] : [{ t: ending.label }],
          color: ending.color,
        };
      return {
        key: `s${String(index)}`,
        order: index,
        at: step.at,
        parts:
          step.to === 'queued'
            ? [{ t: deployment.stop ? 'Stop queued' : 'Deployment queued' }]
            : [{ t: STEPS[step.to]?.label ?? step.to }],
      };
    }),
    ...timeline.actions.map((action, index): TimelineLine & { order: number } => {
      const row = agentActionRow(action);
      return {
        key: `a${action.id}`,
        order: steps.length + index,
        at: action.createdAt,
        parts: [
          { t: '{action} → {server}', values: { action: row.action, server: row.server } },
          { t: row.result.label, values: row.values },
          ...(row.reason ? [{ t: row.reason }] : []),
        ],
        color: row.result.color === RED ? RED : undefined,
      };
    }),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.order - b.order);

  return {
    status: deploymentStatus(deployment.state, deployment.stop),
    stats,
    lines: lines.map(({ order: _order, ...line }) => ({ ...line, at: clockSeconds(line.at) })),
    truncated: timeline.truncated,
    finished,
  };
}

/** "< 1 s", "14 s", "2 min", "1 h 5 min": whole units, so no decimal mark to translate. */
export function stepDuration(ms: number): Text {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (ms < 1000) return { t: '< 1 s' };
  if (seconds < 100) return { t: '{n} s', values: { n: seconds } };
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { t: '{n} min', values: { n: minutes } };
  return {
    t: '{h} h {m} min',
    values: { h: Math.floor(minutes / 60), m: minutes % 60 },
  };
}

/** HH:mm:ss, as the design's log writes times: the steps above give the date. */
function clockSeconds(at: string): string {
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}
