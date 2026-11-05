import { ConflictError, InvalidInputError } from './errors.js';

/** SPEC 5.1 deployment states, in pipeline order, then the terminal outcomes. */
export const DEPLOYMENT_STATES = [
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
  'failed',
  'cancelled',
  'rolled_back',
] as const;
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

const PIPELINE: readonly DeploymentState[] = [
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
];
const FINISHED: ReadonlySet<DeploymentState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'rolled_back',
]);
const MAX_ERROR = 512;

/** What the pipeline must do for this deployment; fixed when it is queued. */
export interface DeploymentPlan {
  /** False for image sources: `building` and `built` are skipped. */
  readonly build: boolean;
  /** False when no release command is defined: `releasing` is skipped (SPEC 5.1). */
  readonly release: boolean;
}

export interface Deployment {
  readonly id: string;
  readonly state: DeploymentState;
  readonly plan: DeploymentPlan;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly error: string | null;
}

/** How a stopped deployment leaves traffic (SPEC 5.1). */
export type RoutingOutcome = 'untouched' | 'restore_previous' | 'new_release_serving';

export function isFinished(state: DeploymentState): boolean {
  return FINISHED.has(state);
}

/** At most one unfinished deployment per application (SPEC 4). */
export function isActive(state: DeploymentState): boolean {
  return !FINISHED.has(state);
}

/** The state after `state` for this plan, skipping stages the plan does not need. */
export function nextState(state: DeploymentState, plan: DeploymentPlan): DeploymentState {
  const index = PIPELINE.indexOf(state);
  if (index < 0 || state === 'succeeded') throw invalidTransition(state, 'advance');
  for (const candidate of PIPELINE.slice(index + 1)) {
    if (!plan.build && (candidate === 'building' || candidate === 'built')) continue;
    if (!plan.release && candidate === 'releasing') continue;
    return candidate;
  }
  throw invalidTransition(state, 'advance');
}

export function advance(deployment: Deployment, now: Date): Deployment {
  const state = nextState(deployment.state, deployment.plan);
  return { ...deployment, state, finishedAt: state === 'succeeded' ? now : null };
}

/**
 * Stops an unfinished deployment as failed or cancelled. Routing is untouched before
 * `switching`, restored to the previous upstreams during it, and already serving the new release
 * once draining began.
 */
export function stop(
  deployment: Deployment,
  outcome: 'failed' | 'cancelled',
  error: string | null,
  now: Date,
): { deployment: Deployment; routing: RoutingOutcome } {
  if (isFinished(deployment.state)) throw invalidTransition(deployment.state, outcome);
  const routing: RoutingOutcome =
    deployment.state === 'switching'
      ? 'restore_previous'
      : deployment.state === 'draining'
        ? 'new_release_serving'
        : 'untouched';
  return {
    deployment: { ...deployment, state: outcome, finishedAt: now, error: boundedError(error) },
    routing,
  };
}

/** Marks a succeeded deployment as superseded by a rollback to an earlier release. */
export function rollBack(deployment: Deployment): Deployment {
  if (deployment.state !== 'succeeded') throw invalidTransition(deployment.state, 'roll back');
  return { ...deployment, state: 'rolled_back' };
}

/** Every transition SPEC 5.1 allows, for documentation and exhaustive tests. */
export function allowedTransitions(state: DeploymentState): readonly DeploymentState[] {
  if (state === 'succeeded') return ['rolled_back'];
  if (isFinished(state)) return [];
  const forward = PIPELINE.slice(PIPELINE.indexOf(state) + 1);
  return [...forward, 'failed', 'cancelled'];
}

function boundedError(error: string | null): string | null {
  if (error === null) return null;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  const clean = error.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!clean) throw new InvalidInputError('invalid_deployment_error', 'A failure needs a reason.');
  return clean.slice(0, MAX_ERROR);
}

function invalidTransition(state: DeploymentState, action: string): ConflictError {
  return new ConflictError(
    'invalid_deployment_transition',
    `A ${state} deployment cannot ${action}.`,
    {
      state,
    },
  );
}
