import { AMBER, BLUE, GREEN, GREY, RED } from '../dashboard/format';

import { actionName, agentActionRow, timestamp } from './agent-action-rows';
import type { AgentAction } from './delivery-api';
import { FR } from '../ui/fr';

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
    expect(row.reason).toBe('lease superseded');
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

  it('says why an agent upgrade was refused, in French too (ADR 0028)', () => {
    const labels = {
      upgrade_dev_build: 'development build, not upgraded',
      upgrade_not_newer: 'already on this version or a later one',
      upgrade_unit_outdated: 'service predates upgrades',
      upgrade_unverified: 'release did not verify',
      upgrade_unavailable: 'release download failed',
      upgrade_in_progress: 'another upgrade not confirmed yet',
    } as const;
    for (const [reason, label] of Object.entries(labels)) {
      const row = agentActionRow({
        ...base,
        kind: 'upgradeAgent',
        state: 'compensated',
        outcome: 'compensated',
        reason: reason as keyof typeof labels,
      });
      expect(row.action).toBe('UpgradeAgent');
      expect(row.reason).toBe(label);
      expect(FR[label], label).toBeTruthy();
    }
  });

  it('says why a pull was undone, in French too, and why a deployment failed', () => {
    const undone = (reason: AgentAction['reason']) =>
      agentActionRow({
        ...base,
        kind: 'pullImage',
        state: 'compensated',
        outcome: 'compensated',
        reason,
      });
    const labels = {
      registry_denied: 'registry refused the pull',
      image_not_found: 'image not found',
      registry_unreachable: 'registry unreachable',
      registry_untrusted: 'registry certificate not trusted',
      disk_full: 'disk full',
      egress_unguarded: 'egress proxy missing',
    } as const;
    for (const [reason, label] of Object.entries(labels)) {
      expect(undone(reason as keyof typeof labels).reason).toBe(label);
      expect(FR[label], label).toBeTruthy();
    }
    // The sentences the API writes on a failed deployment (deployments/domain/pipeline.ts).
    for (const sentence of [
      'The server could not pull the image: the registry refused it. The image is private, the stored credentials are wrong, or it does not exist.',
      'The server could not pull the image: the registry does not have it.',
      'The server could not pull the image: it could not reach the registry.',
      "The server could not pull the image: it does not trust the registry's certificate.",
      'The server could not pull the image: its disk is full.',
    ])
      expect(FR[sentence], sentence).toMatch(/^Le serveur n'a pas pu récupérer l'image : /);
    expect(
      FR[
        "The server refused to pull the image: its Docker daemon does not go through Shipkeep's egress proxy, which keeps a registry from reaching the server's own network. Run the server installer again with --migrate yes to restore it."
      ],
    ).toMatch(/^Le serveur a refusé de récupérer l'image : /);
  });

  it('says when a container name is taken, in French too (issue #501)', () => {
    const row = agentActionRow({
      ...base,
      kind: 'createContainer',
      state: 'compensated',
      outcome: 'compensated',
      reason: 'container_name_taken',
    });
    expect(row.reason).toBe('container name already in use');
    expect(FR['container name already in use']).toBeTruthy();
    expect(
      FR[
        'The server did not create the container: another container already has its name. After a restore from an older backup, it is likely the container of a deployment that the backup does not know, and each such deployment makes one more attempt fail: deploy again until one succeeds. That container then shows as untracked on the page of its server, where it can be removed once you have checked that it is no longer needed.'
      ],
    ).toMatch(/^Le serveur n'a pas créé le conteneur : /);
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
