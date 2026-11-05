import { PERMISSIONS, type Permission } from './api-token-policy.js';
import {
  allowsTenantAction,
  canChangeMembership,
  isTenantId,
  type TenantMembership,
  type TenantResource,
} from './organization-policy.js';

const org = '018f4400-0000-7000-8000-000000000001';
const project = '018f4400-0000-7000-8000-000000000002';
const env = '018f4400-0000-7000-8000-000000000003';
const other = '018f4400-0000-7000-8000-000000000004';
it('accepts only canonical UUIDv7 tenant identifiers', () => {
  expect(isTenantId(org)).toBe(true);
  for (const value of [undefined, null, 1, '', org.toUpperCase(), org.replace('-7000-', '-4000-')])
    expect(isTenantId(value)).toBe(false);
});
const organization = { organizationId: org };
const projectTarget = { ...organization, projectId: project };
const environment = { ...projectTarget, environmentId: env, protected: false };
const principals: readonly TenantMembership[] = [
  { organizationId: org, role: 'owner', bindings: [] },
  { organizationId: org, role: 'admin', bindings: [] },
  ...(['admin', 'developer', 'viewer'] as const).map((role) => ({
    organizationId: org,
    role: 'member' as const,
    bindings: [{ projectId: project, role }],
  })),
];
// Independent expected matrix from SPEC 7: owner, org admin, project admin, developer, viewer.
const matrix: Record<Permission, { target: TenantResource; expected: string }> = {
  'profile.read': { target: {}, expected: '00000' },
  'organization.read': { target: organization, expected: '11111' },
  'organization.delete': { target: organization, expected: '10000' },
  'billing.manage': { target: organization, expected: '10000' },
  'member.manage': { target: projectTarget, expected: '11100' },
  'node.manage': { target: organization, expected: '11000' },
  'project.read': { target: projectTarget, expected: '11111' },
  'project.create': { target: organization, expected: '11000' },
  'project.delete': { target: projectTarget, expected: '11000' },
  'environment.read': { target: environment, expected: '11111' },
  'environment.create': { target: projectTarget, expected: '11100' },
  'environment.delete': { target: environment, expected: '11100' },
  'deploy.run': { target: environment, expected: '11110' },
  'secret.write': { target: environment, expected: '11110' },
  'container.exec': { target: environment, expected: '11110' },
  'volume.delete': { target: environment, expected: '11100' },
  'database.delete': { target: environment, expected: '11100' },
  'observability.read': { target: environment, expected: '11111' },
  'audit.read': { target: projectTarget, expected: '11100' },
};

describe('tenant permission policy', () => {
  it.each(PERMISSIONS)('implements the five-role matrix for %s', (permission) => {
    const { target, expected } = matrix[permission];
    expect(
      principals.map((actor) => Number(allowsTenantAction(actor, permission, target))).join(''),
    ).toBe(expected);
  });

  it.each(['deploy.run', 'secret.write', 'container.exec'])(
    'requires an admin for protected or unknown-protection %s',
    (permission) => {
      for (const protectedValue of [true, undefined]) {
        const target = { ...environment, protected: protectedValue };
        expect(
          principals.map((actor) => Number(allowsTenantAction(actor, permission, target))).join(''),
        ).toBe(protectedValue ? '11100' : '00000');
      }
    },
  );

  it('denies cross-tenant requests, unknown capabilities and missing membership even to owners', () => {
    for (const permission of PERMISSIONS) {
      const target = { ...matrix[permission].target, organizationId: other };
      expect(allowsTenantAction(principals[0], permission, target)).toBe(false);
      expect(allowsTenantAction(undefined, permission, matrix[permission].target)).toBe(false);
    }
    for (const permission of [
      '*',
      'secret.read',
      '__proto__',
      'constructor',
      'organization.update',
    ])
      expect(allowsTenantAction(principals[0], permission, environment)).toBe(false);
    expect(
      allowsTenantAction(
        { organizationId: org, role: 'root', bindings: [] },
        'organization.read',
        organization,
      ),
    ).toBe(false);
  });

  it('rejects incomplete, malformed and inappropriate resource contexts', () => {
    for (const target of [
      {},
      { projectId: project },
      { ...organization, environmentId: env },
      { organizationId: 'bad' },
    ])
      expect(allowsTenantAction(principals[0], 'organization.read', target)).toBe(false);
    for (const permission of ['deploy.run', 'environment.read', 'volume.delete'])
      expect(allowsTenantAction(principals[0], permission, projectTarget)).toBe(false);
    for (const permission of [
      'project.create',
      'project.delete',
      'environment.create',
      'billing.manage',
    ])
      expect(allowsTenantAction(principals[0], permission, environment)).toBe(false);
  });

  it('keeps members without bindings out of projects and organization administration', () => {
    const actor = { organizationId: org, role: 'member', bindings: [] };
    expect(allowsTenantAction(actor, 'organization.read', organization)).toBe(true);
    for (const permission of PERMISSIONS.filter((value) => value !== 'organization.read'))
      expect(allowsTenantAction(actor, permission, matrix[permission].target)).toBe(false);
    for (const permission of ['member.manage', 'audit.read', 'observability.read'])
      expect(allowsTenantAction(principals[2], permission, organization)).toBe(false);
  });

  it('uses an explicit environment binding instead of inheriting a broader project role', () => {
    const actor = {
      organizationId: org,
      role: 'member',
      bindings: [
        { projectId: project, role: 'admin' },
        { projectId: project, environmentId: env, role: 'viewer' },
      ],
    };
    expect(allowsTenantAction(actor, 'deploy.run', environment)).toBe(false);
    expect(allowsTenantAction(actor, 'deploy.run', { ...environment, environmentId: other })).toBe(
      true,
    );
    expect(allowsTenantAction(actor, 'environment.read', environment)).toBe(true);
    expect(allowsTenantAction(actor, 'project.read', { ...projectTarget, projectId: other })).toBe(
      false,
    );
  });

  it('limits environment-only grants to that environment and parent navigation', () => {
    const actor = {
      organizationId: org,
      role: 'member',
      bindings: [{ projectId: project, environmentId: env, role: 'admin' }],
    };
    expect(allowsTenantAction(actor, 'project.read', projectTarget)).toBe(true);
    expect(allowsTenantAction(actor, 'member.manage', environment)).toBe(true);
    expect(allowsTenantAction(actor, 'member.manage', projectTarget)).toBe(false);
    expect(allowsTenantAction(actor, 'environment.create', projectTarget)).toBe(false);
    expect(
      allowsTenantAction(actor, 'environment.read', { ...environment, environmentId: other }),
    ).toBe(false);
  });

  it('denies ambiguous duplicate bindings and malformed roles rather than taking the strongest grant', () => {
    for (const bindings of [
      [{ projectId: project, role: 'root' }],
      [
        { projectId: project, role: 'admin' },
        { projectId: project, role: 'viewer' },
      ],
      [
        { projectId: project, role: 'admin' },
        { projectId: project, environmentId: env, role: 'invalid' },
      ],
    ])
      expect(
        allowsTenantAction(
          { organizationId: org, role: 'member', bindings },
          'deploy.run',
          environment,
        ),
      ).toBe(false);
  });
});

describe('organization membership changes', () => {
  it('allows owners to change roles but preserves the last owner', () => {
    expect(canChangeMembership('owner', 'owner', 'admin', 1)).toBe(false);
    expect(canChangeMembership('owner', 'owner', undefined, 1)).toBe(false);
    expect(canChangeMembership('owner', 'owner', 'owner', 1)).toBe(true);
    expect(canChangeMembership('owner', 'owner', 'admin', 2)).toBe(true);
    expect(canChangeMembership('owner', 'member', 'owner', 1)).toBe(true);
  });
  it('prevents admins and members from changing ownership or escalating their authority', () => {
    expect(canChangeMembership('admin', 'member', 'admin', 1)).toBe(true);
    expect(canChangeMembership('admin', 'admin', undefined, 1)).toBe(true);
    expect(canChangeMembership('admin', 'owner', 'owner', 2)).toBe(false);
    expect(canChangeMembership('admin', 'owner', undefined, 2)).toBe(false);
    expect(canChangeMembership('admin', 'member', 'owner', 1)).toBe(false);
    expect(canChangeMembership('member', 'member', 'admin', 1)).toBe(false);
    for (const count of [0, -1, 1.5, NaN, Infinity])
      expect(canChangeMembership('owner', 'owner', 'admin', count)).toBe(false);
    expect(canChangeMembership('root', 'member', 'admin', 1)).toBe(false);
    expect(canChangeMembership('owner', 'unknown', 'admin', 1)).toBe(false);
    expect(canChangeMembership('owner', 'member', 'unknown', 1)).toBe(false);
  });
});
