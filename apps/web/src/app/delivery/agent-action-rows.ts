import { AMBER, BLUE, GREEN, GREY, RED, type Status } from '../dashboard/format';

import type { AgentAction } from './delivery-api';

/** One line of the application's Agent actions section. Texts are English, for `| t`. */
export interface AgentActionRow {
  readonly id: string;
  /** ISO time the action was queued. */
  readonly at: string;
  readonly action: string;
  readonly server: string;
  readonly result: Status;
  /** Placeholders of the result label. */
  readonly values: Readonly<Record<string, number>>;
  /** Why the agent refused or failed it, when the API gave a reason. */
  readonly reason: string | null;
  readonly deploymentId: string | null;
}

const REASONS: Readonly<Record<NonNullable<AgentAction['reason']>, string | null>> = {
  malformed_request: 'malformed request',
  unsupported_action: 'not supported by this agent',
  stale_lease_epoch: 'lease expired',
  invalid_input: 'invalid input',
  idempotency_conflict: 'conflicting retry',
  deadline_exceeded: 'deadline exceeded',
  action_failed: null,
  unknown: 'unknown error',
};

/** `startContainer` → `StartContainer`, the name in the closed action list (SPEC 3.3). */
export function actionName(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** dd/MM HH:mm:ss: the actions of one deployment are seconds apart. */
export function timestamp(at: string): string {
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(date.getDate())}/${two(date.getMonth() + 1)} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

export function agentActionRow(action: AgentAction): AgentActionRow {
  const { result, values } = outcome(action);
  return {
    id: action.id,
    at: action.createdAt,
    action: actionName(action.kind),
    server: action.nodeName,
    result,
    values,
    reason: action.reason ? REASONS[action.reason] : null,
    deploymentId: action.deploymentId,
  };
}

function outcome(action: AgentAction): { result: Status; values: Record<string, number> } {
  const plain = (label: string, color: string) => ({ result: { label, color }, values: {} });
  switch (action.outcome) {
    case 'succeeded': {
      // The action ran, but what it checked did not pass: the deployment fails on it.
      if (action.result?.healthy === false) return plain('unhealthy', RED);
      const code = action.result?.exitCode;
      if (typeof code === 'number' && code !== 0)
        return { result: { label: 'exit code {code}', color: RED }, values: { code } };
      return plain('ok', GREEN);
    }
    case 'refused':
      return plain('refused', AMBER);
    case 'failed':
      return plain('failed', RED);
    case 'expired':
      return plain('expired', RED);
    case 'cancelled':
      return plain('cancelled', GREY);
    case 'compensated':
      return plain('undone', GREY);
    default:
      return plain(action.state === 'queued' ? 'queued' : 'running', BLUE);
  }
}
