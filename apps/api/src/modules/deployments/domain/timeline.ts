import { DEPLOYMENT_STATES, type DeploymentState } from '@shipkeep/domain';

/** The audited changes of a deployment's state (SPEC 5.1), oldest first, as the timeline reads them. */
export const STEP_ACTIONS = [
  'deployment.queued',
  'deployment.advanced',
  'deployment.failed',
  'deployment.cancelled',
  'deployment.rolled_back',
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** Most steps one timeline reads: a full pipeline has about ten. */
export const MAX_STEPS = 100;

/** An audited event of one deployment: what the store reads, nothing more. */
export interface StepEvent {
  readonly action: string;
  readonly metadata: unknown;
  readonly at: Date;
}

/** One change of state: when the deployment entered `to`, and from which state. */
export interface DeploymentStep {
  readonly from: DeploymentState | null;
  readonly to: DeploymentState;
  readonly at: Date;
  /** Why it failed, for `failed`; null otherwise. */
  readonly reason: string | null;
}

const states: ReadonlySet<string> = new Set(DEPLOYMENT_STATES);

function state(value: unknown): DeploymentState | null {
  return typeof value === 'string' && states.has(value) ? (value as DeploymentState) : null;
}

/**
 * The steps of a deployment from its audited events (#265). Events it does not know, or whose
 * states are not deployment states, are left out rather than guessed.
 */
export function deploymentSteps(events: readonly StepEvent[]): DeploymentStep[] {
  const steps: DeploymentStep[] = [];
  for (const event of events) {
    const metadata =
      event.metadata && typeof event.metadata === 'object'
        ? (event.metadata as Record<string, unknown>)
        : {};
    const from = state(metadata['from']);
    const to = target(event.action as StepAction, metadata);
    if (!to) continue;
    const reason =
      to === 'failed' && typeof metadata['reason'] === 'string' && metadata['reason']
        ? metadata['reason'].slice(0, 512)
        : null;
    steps.push({ from, to, at: event.at, reason });
  }
  return steps;
}

function target(action: StepAction, metadata: Record<string, unknown>): DeploymentState | null {
  switch (action) {
    case 'deployment.queued':
      return 'queued';
    case 'deployment.advanced':
      return state(metadata['to']);
    case 'deployment.failed':
      return 'failed';
    case 'deployment.cancelled':
      return 'cancelled';
    case 'deployment.rolled_back':
      return 'rolled_back';
    default:
      return null;
  }
}
