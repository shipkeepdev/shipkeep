import type { ShipkeepConfig } from '@shipkeep/config-schema';

import {
  assertRollbackTarget,
  assertSecretsSet,
  type DeploymentRecord,
  deploymentInProgress,
  type Release,
  releaseDraft,
  rollbackDraft,
} from './release';

const config = (overrides: Partial<ShipkeepConfig> = {}): ShipkeepConfig => ({
  version: 1,
  name: 'billing-api',
  build: { type: 'image', image: 'ghcr.io/acme/billing:1.4.2' },
  run: { port: 3000 },
  ...overrides,
});

describe('releaseDraft', () => {
  it('pulls the image, skips the build and runs a release step only when defined', () => {
    expect(releaseDraft(config())).toEqual({
      image: 'ghcr.io/acme/billing:1.4.2',
      plan: { build: false, release: false },
      secrets: [],
    });
    expect(releaseDraft(config({ release: { command: ['node', 'migrate.js'] } })).plan).toEqual({
      build: false,
      release: true,
    });
  });

  it('lists each referenced secret once, sorted', () => {
    expect(releaseDraft(config({ secrets: ['STRIPE_KEY', 'DATABASE_URL'] })).secrets).toEqual([
      'DATABASE_URL',
      'STRIPE_KEY',
    ]);
  });

  it('refuses sources that need a build', () => {
    expect(() => releaseDraft(config({ build: { type: 'dockerfile' } }))).toThrow(
      expect.objectContaining({ code: 'unsupported_application_source' }),
    );
  });
});

describe('assertSecretsSet', () => {
  it('names the missing secrets and passes when all are set', () => {
    expect(() => {
      assertSecretsSet(['A', 'B', 'C'], ['B']);
    }).toThrow(
      expect.objectContaining({ code: 'secrets_missing', details: { missing: ['A', 'C'] } }),
    );
    expect(() => {
      assertSecretsSet(['A'], ['A', 'B']);
    }).not.toThrow();
    expect(() => {
      assertSecretsSet([], []);
    }).not.toThrow();
  });
});

describe('deploymentInProgress', () => {
  it('is a conflict that may report the running state', () => {
    expect(deploymentInProgress('queued')).toMatchObject({
      kind: 'conflict',
      code: 'deployment_in_progress',
      details: { state: 'queued' },
    });
    expect(deploymentInProgress().details).toBeUndefined();
  });
});

describe('rollback', () => {
  const release = (overrides: Partial<Release> = {}): Release => ({
    id: 'r1',
    organizationId: 'o',
    applicationId: 'a',
    number: 1,
    image: 'ghcr.io/acme/billing:1.4.2',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    config: config({ release: { command: ['migrate'] }, secrets: ['B', 'A', 'B'] }),
    configSha: 'c'.repeat(64),
    createdBy: null,
    createdAt: new Date(0),
    ...overrides,
  });
  const deployment = (state: DeploymentRecord['state'], releaseId = 'r1'): DeploymentRecord => ({
    id: `d-${releaseId}`,
    organizationId: 'o',
    applicationId: 'a',
    releaseId,
    state,
    plan: { build: false, release: false },
    trigger: 'manual',
    actorId: null,
    startedAt: new Date(0),
    finishedAt: null,
    error: null,
  });

  it('copies the release but never replays its release command', () => {
    expect(rollbackDraft(release())).toEqual({
      image: 'ghcr.io/acme/billing:1.4.2',
      plan: { build: false, release: false },
      secrets: ['A', 'B'],
    });
  });

  it('refuses a release that never resolved its image', () => {
    expect(() => rollbackDraft(release({ imageDigest: null }))).toThrow(
      expect.objectContaining({ code: 'release_not_deployable' }),
    );
  });

  it('accepts only versions that ran and are not serving', () => {
    const serving = deployment('succeeded', 'r2');
    expect(() => {
      assertRollbackTarget(deployment('succeeded'), serving);
    }).not.toThrow();
    expect(() => {
      assertRollbackTarget(deployment('rolled_back'), serving);
    }).not.toThrow();
    for (const state of ['failed', 'cancelled', 'queued', 'switching'] as const)
      expect(() => {
        assertRollbackTarget(deployment(state), serving);
      }).toThrow(expect.objectContaining({ code: 'rollback_target_invalid' }));
    expect(() => {
      assertRollbackTarget(deployment('succeeded', 'r2'), serving);
    }).toThrow(expect.objectContaining({ code: 'release_already_serving' }));
  });
});
