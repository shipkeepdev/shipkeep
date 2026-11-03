import { create } from '@bufbuild/protobuf';

import { EnsureNetworkSchema } from '../gen/shipkeep/agent/v1/actions_pb.js';
import { ActionRequestSchema } from '../gen/shipkeep/agent/v1/gateway_pb.js';

import { ACTION_KINDS, actionKind } from './action-kinds.js';

// The 23 actions of SPEC section 3.3. Changing this list is a contract change (CLAUDE.md, rule 2).
const SPEC_ACTIONS = [
  'ensureNetwork',
  'pullImage',
  'buildImage',
  'createContainer',
  'startContainer',
  'stopContainer',
  'removeContainer',
  'ensureVolume',
  'removeVolume',
  'healthCheck',
  'upsertRoute',
  'removeRoute',
  'runReleaseTask',
  'execSession',
  'backupVolume',
  'restoreVolume',
  'dumpDatabase',
  'restoreDatabase',
  'configurePeers',
  'collectFacts',
  'upgradeAgent',
  'stopStatefulWorkloads',
  'upgradeControlPlane',
] as const;

describe('ACTION_KINDS', () => {
  it('matches the closed catalogue of SPEC section 3.3 exactly', () => {
    expect([...ACTION_KINDS]).toEqual([...SPEC_ACTIONS]);
  });
});

describe('actionKind', () => {
  it('returns the set action', () => {
    const request = create(ActionRequestSchema, {
      actionId: '0192f0c0-0000-7000-8000-000000000000',
      action: { case: 'ensureNetwork', value: create(EnsureNetworkSchema, { name: 'sk-prod' }) },
    });
    expect(actionKind(request)).toBe('ensureNetwork');
  });

  it('returns undefined for an empty request', () => {
    expect(actionKind(create(ActionRequestSchema))).toBeUndefined();
  });
});
