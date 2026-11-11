/** Lifecycle of a queued agent action (PLAN M1.4a2). Agent states mirror SPEC 3.4. */
export const AGENT_ACTION_STATES = [
  'queued',
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'compensating',
  'compensated',
  'expired',
] as const;
export type AgentActionState = (typeof AGENT_ACTION_STATES)[number];

const terminal: ReadonlySet<AgentActionState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'compensated',
  'expired',
]);

/** Terminal states never change again, whatever a late or replayed update says. */
export function isTerminalAction(state: AgentActionState): boolean {
  return terminal.has(state);
}

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
/** Longest deadline a queued action may have. */
export const MAX_ACTION_LIFETIME_MS = 24 * 3600_000;

export interface AgentActionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly nodeId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  /** Plaintext ActionRequest (action only) in protobuf binary; encrypted at rest by the store. */
  readonly payload: Uint8Array;
  readonly leaseEpoch: number;
  readonly deadline: Date;
  readonly state: AgentActionState;
  readonly step: string;
  readonly attempts: number;
  readonly result: unknown;
  readonly error: string | null;
  readonly requestedBy: string | null;
  /** The application and deployment that requested the action; null for other actions. */
  readonly applicationId: string | null;
  readonly deploymentId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export interface AgentActionChange {
  readonly state: AgentActionState;
  readonly step: string;
  readonly attempts: number;
  readonly result: unknown;
  readonly error: string | null;
  readonly at: Date;
}

/** What an action came to, for people reading its history. */
export const ACTION_OUTCOMES = [
  'in_progress',
  'succeeded',
  'refused',
  'failed',
  'expired',
  'cancelled',
  'compensated',
] as const;
export type ActionOutcome = (typeof ACTION_OUTCOMES)[number];

/** Stable code for why an action failed; agents send fixed, redacted texts (SPEC 3.4). */
export const ACTION_REASONS = [
  'malformed_request',
  'unsupported_action',
  'stale_lease_epoch',
  'invalid_input',
  'idempotency_conflict',
  'deadline_exceeded',
  'action_failed',
  'unknown',
] as const;
export type ActionReason = (typeof ACTION_REASONS)[number];

const AGENT_ERRORS: Readonly<Record<string, ActionReason>> = {
  'malformed action request': 'malformed_request',
  'action not supported by this agent': 'unsupported_action',
  'stale lease epoch': 'stale_lease_epoch',
  'invalid action input': 'invalid_input',
  'idempotency key reused for a different action': 'idempotency_conflict',
  'action deadline exceeded': 'deadline_exceeded',
  'action failed': 'action_failed',
};
/** The agent refused these before journaling anything: nothing ran on the node. */
const REFUSALS: ReadonlySet<ActionReason> = new Set([
  'malformed_request',
  'unsupported_action',
  'stale_lease_epoch',
  'invalid_input',
  'idempotency_conflict',
]);

/** The fields of a typed result that are safe to show; never logs, outputs or errors. */
export type ActionResultSummary =
  | { readonly type: 'container'; readonly containerId: string }
  | { readonly type: 'image'; readonly imageDigest: string }
  | { readonly type: 'health_check'; readonly healthy: boolean }
  | { readonly type: 'release_task'; readonly exitCode: number }
  | { readonly type: 'transfer' }
  | { readonly type: 'facts' };

export interface AgentActionSummary {
  readonly outcome: ActionOutcome;
  readonly reason: ActionReason | null;
  readonly result: ActionResultSummary | null;
}

const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const INT32 = 2 ** 31;

/**
 * Outcome, reason and result of an action as they may be shown. Error texts are mapped to codes
 * and results reduced to validated fields, so nothing the agent sent is echoed verbatim.
 */
export function summarizeAction(action: {
  readonly state: AgentActionState;
  readonly error: string | null;
  readonly result: unknown;
}): AgentActionSummary {
  switch (action.state) {
    case 'succeeded':
      return { outcome: 'succeeded', reason: null, result: summarizeResult(action.result) };
    case 'failed': {
      // Own-property lookup only: an error text such as `constructor` maps to `unknown`.
      const reason =
        action.error === null
          ? 'action_failed'
          : Object.hasOwn(AGENT_ERRORS, action.error)
            ? (AGENT_ERRORS[action.error] ?? 'unknown')
            : 'unknown';
      return { outcome: REFUSALS.has(reason) ? 'refused' : 'failed', reason, result: null };
    }
    case 'expired':
    case 'cancelled':
    case 'compensated':
      return { outcome: action.state, reason: null, result: null };
    default:
      return { outcome: 'in_progress', reason: null, result: null };
  }
}

function summarizeResult(result: unknown): ActionResultSummary | null {
  if (!isObject(result)) return null;
  const { containerId, imageDigest, buildImage, healthCheck, releaseTask, transfer, facts } =
    result;
  if (typeof containerId === 'string')
    return CONTAINER_ID.test(containerId) ? { type: 'container', containerId } : null;
  if (imageDigest !== undefined) return image(imageDigest);
  if (isObject(buildImage)) return image(buildImage['imageDigest']);
  if (isObject(healthCheck)) {
    const healthy = healthCheck['healthy'] ?? false;
    return typeof healthy === 'boolean' ? { type: 'health_check', healthy } : null;
  }
  if (isObject(releaseTask)) {
    const exitCode = releaseTask['exitCode'] ?? 0;
    return typeof exitCode === 'number' &&
      Number.isInteger(exitCode) &&
      exitCode >= -INT32 &&
      exitCode < INT32
      ? { type: 'release_task', exitCode }
      : null;
  }
  if (isObject(transfer)) return { type: 'transfer' };
  if (isObject(facts)) return { type: 'facts' };
  return null;
}

function image(digest: unknown): ActionResultSummary | null {
  return typeof digest === 'string' && DIGEST.test(digest)
    ? { type: 'image', imageDigest: digest }
    : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
