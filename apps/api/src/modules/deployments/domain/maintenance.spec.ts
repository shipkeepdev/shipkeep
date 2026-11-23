import {
  agentsWithoutMaintenancePage,
  inMaintenance,
  maintenanceDraft,
  servesMaintenancePage,
} from './maintenance';
import type { DeploymentRecord, Release } from './release';

const succeeded = (plan: DeploymentRecord['plan']): DeploymentRecord => ({
  id: 'd',
  organizationId: 'o',
  applicationId: 'a',
  releaseId: 'r',
  state: 'succeeded',
  plan,
  trigger: 'manual',
  actorId: null,
  error: null,
  startedAt: new Date(0),
  finishedAt: new Date(0),
});

describe('maintenance (ADR 0025)', () => {
  it('is on only when the deployment that serves entered it', () => {
    expect(inMaintenance(succeeded({ build: false, release: false, maintenance: 'enter' }))).toBe(
      true,
    );
    expect(inMaintenance(succeeded({ build: false, release: false, maintenance: 'leave' }))).toBe(
      false,
    );
    expect(inMaintenance(succeeded({ build: false, release: true }))).toBe(false);
    // After a stop nothing serves.
    expect(inMaintenance(undefined)).toBe(false);
  });

  it('runs the release that serves, with nothing to build, release or inject', () => {
    const running = { image: 'ghcr.io/acme/billing:1.4.2' } as Release;
    expect(maintenanceDraft(running, 'leave')).toEqual({
      image: running.image,
      plan: { build: false, release: false, maintenance: 'leave' },
      secrets: [],
    });
  });

  it('knows which agents predate the page, and names their servers', () => {
    for (const version of ['0.1.0-alpha.1', '0.1.0-alpha.2', '0.1.0-alpha.3'])
      expect(servesMaintenancePage(version)).toBe(false);
    for (const version of ['0.1.0-alpha.4', '0.1.0', 'dev', undefined])
      expect(servesMaintenancePage(version)).toBe(true);
    expect(agentsWithoutMaintenancePage(['edge-2', 'edge-1'])).toMatchObject({
      code: 'agent_outdated',
      details: { servers: ['edge-1', 'edge-2'] },
    });
  });
});
