import { AMBER, BLUE, GREEN, GREY, RED } from '../dashboard/format';

import { actionName, agentActionRow, timestamp } from './agent-action-rows';
import type { AgentAction } from './delivery-api';

const base: AgentAction = {
  id: '0190f5a8-7b1c-7e2d-8f3a-000000000101',
  kind: 'startContainer',
  nodeId: '0190f5a8-7b1c-7e2d-8f3a-000000000102',
  nodeName: 'srv-par-1',
  state: 'succeeded',
  step: 'started',
  attempts: 1,
  outcome: 'succeeded',
  reason: null,
  result: null,
  deploymentId: '0190f5a8-7b1c-7e2d-8f3a-000000000103',
  createdAt: '2026-11-11T10:12:58Z',
  updatedAt: '2026-11-11T10:13:01Z',
  completedAt: '2026-11-11T10:13:01Z',
};
const result = (fields: Partial<NonNullable<AgentAction['result']>>) => ({
  type: 'container' as const,
  containerId: null,
  imageDigest: null,
  healthy: null,
  exitCode: null,
  ...fields,
});

describe('agent action rows', () => {
  it('names actions as the closed list does', () => {
    expect(actionName('startContainer')).toBe('StartContainer');
    expect(actionName('upsertRoute')).toBe('UpsertRoute');
    expect(actionName('runReleaseTask')).toBe('RunReleaseTask');
  });

  it('writes the day and the time to the second', () => {
    const at = new Date(2026, 10, 11, 9, 5, 7).toISOString();
    expect(timestamp(at)).toBe('11/11 09:05:07');
  });

  it('shows a success as ok, with the server and the deployment', () => {
    expect(agentActionRow(base)).toEqual({
      id: base.id,
      at: base.createdAt,
      action: 'StartContainer',
      server: 'srv-par-1',
      result: { label: 'ok', color: GREEN },
      values: {},
      reason: null,
      deploymentId: base.deploymentId,
    });
  });

  it('shows a refusal with its reason, as the design does for an expired lease', () => {
    const row = agentActionRow({
      ...base,
      kind: 'stopContainer',
      state: 'failed',
      outcome: 'refused',
      reason: 'stale_lease_epoch',
    });
    expect(row.result).toEqual({ label: 'refused', color: AMBER });
    expect(row.reason).toBe('lease expired');
  });

  it('gives every failure reason a fixed text, and none for a plain failure', () => {
    const failed = (reason: AgentAction['reason']) =>
      agentActionRow({ ...base, state: 'failed', outcome: 'failed', reason });
    expect(failed('deadline_exceeded')).toMatchObject({
      result: { label: 'failed', color: RED },
      reason: 'deadline exceeded',
    });
    expect(failed('unknown').reason).toBe('unknown error');
    expect(failed('action_failed').reason).toBeNull();
    for (const reason of [
      'malformed_request',
      'unsupported_action',
      'invalid_input',
      'idempotency_conflict',
    ] as const)
      expect(failed(reason).reason).toMatch(/^[a-z ]+$/);
  });

  it('reports a probe or a release task that ran but did not pass', () => {
    const unhealthy = agentActionRow({
      ...base,
      kind: 'healthCheck',
      result: result({ type: 'health_check', healthy: false }),
    });
    expect(unhealthy.result).toEqual({ label: 'unhealthy', color: RED });
    const exited = agentActionRow({
      ...base,
      kind: 'runReleaseTask',
      result: result({ type: 'release_task', exitCode: 3 }),
    });
    expect(exited.result).toEqual({ label: 'exit code {code}', color: RED });
    expect(exited.values).toEqual({ code: 3 });
    const passed = agentActionRow({
      ...base,
      result: result({ type: 'release_task', exitCode: 0 }),
    });
    expect(passed.result.label).toBe('ok');
  });

  it('shows unfinished, expired, cancelled and undone actions', () => {
    const at = (state: AgentAction['state'], outcome: AgentAction['outcome']) =>
      agentActionRow({ ...base, state, outcome, completedAt: null }).result;
    expect(at('queued', 'in_progress')).toEqual({ label: 'queued', color: BLUE });
    expect(at('running', 'in_progress')).toEqual({ label: 'running', color: BLUE });
    expect(at('expired', 'expired')).toEqual({ label: 'expired', color: RED });
    expect(at('cancelled', 'cancelled')).toEqual({ label: 'cancelled', color: GREY });
    expect(at('compensated', 'compensated')).toEqual({ label: 'undone', color: GREY });
  });
});
