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
