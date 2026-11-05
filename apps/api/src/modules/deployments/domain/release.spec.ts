import type { ShipkeepConfig } from '@shipkeep/config-schema';

import { assertSecretsSet, deploymentInProgress, releaseDraft } from './release';

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
