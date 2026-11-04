import {
  assertApiTokenName,
  assertApiTokenExpiry,
  parseApiScopes,
  scopeCovers,
} from './api-token-policy.js';

const organizationId = '0192f0c0-0000-7000-8000-000000000001';
const projectId = '0192f0c0-0000-7000-8000-000000000002';
const environmentId = '0192f0c0-0000-7000-8000-000000000003';
const other = '0192f0c0-0000-7000-8000-000000000004';

describe('API token policy', () => {
  it('accepts explicit scopes, removes duplicates and copies input before authorization', () => {
    const input = { permission: 'deploy.run', organizationId, projectId };
    const scopes = parseApiScopes([input, input, { permission: 'profile.read' }]);
    expect(scopes).toHaveLength(2);
    input.projectId = other;
    expect(scopes).toContainEqual({ permission: 'deploy.run', organizationId, projectId });
    expect(Object.isFrozen(scopes)).toBe(true);
  });

  it('rejects wildcard/unknown permissions, malformed contexts and oversized scope lists', () => {
    for (const scopes of [
      null,
      {},
      [],
      [null],
      [[]],
      [1],
      [{ permission: 42 }],
      [{ permission: '*' }],
      [{ permission: 'secrets.read', organizationId }],
      [{ permission: 'deploy.run' }],
      [{ permission: 'profile.read', organizationId }],
      [{ permission: 'deploy.run', organizationId, environmentId }],
      [{ permission: 'deploy.run', organizationId: '../escape' }],
      [{ permission: 'deploy.run', organizationId, admin: true }],
      Array.from({ length: 33 }, () => ({ permission: 'profile.read' })),
    ]) {
      expect(() => parseApiScopes(scopes)).toThrow();
    }
  });

  it('never widens resource bounds or crosses organizations, projects or environments', () => {
    const [org] = parseApiScopes([{ permission: 'deploy.run', organizationId }]);
    const [project] = parseApiScopes([{ permission: 'deploy.run', organizationId, projectId }]);
    const [env] = parseApiScopes([
      { permission: 'deploy.run', organizationId, projectId, environmentId },
    ]);
    expect(scopeCovers(org, 'deploy.run', { organizationId, projectId, environmentId })).toBe(true);
    expect(scopeCovers(project, 'deploy.run', { organizationId, projectId, environmentId })).toBe(
      true,
    );
    for (const target of [
      { organizationId: other, projectId, environmentId },
      { organizationId, projectId: other, environmentId },
      { organizationId, projectId, environmentId: other },
      { organizationId, projectId },
      { organizationId, environmentId },
    ]) {
      expect(scopeCovers(env, 'deploy.run', target)).toBe(false);
    }
    expect(scopeCovers(env, 'secret.write', { organizationId, projectId, environmentId })).toBe(
      false,
    );
    expect(scopeCovers(project, 'deploy.run', { organizationId })).toBe(false);
    const [profile] = parseApiScopes([{ permission: 'profile.read' }]);
    expect(scopeCovers(profile, 'profile.read', {})).toBe(true);
    expect(scopeCovers(profile, 'profile.read', { organizationId })).toBe(false);
  });

  it('bounds names and requires expiry between one minute and ninety days', () => {
    expect(assertApiTokenName('  CI deploy  ')).toBe('CI deploy');
    for (const name of ['', ' ', 'a\nheader', 'a\u0085header', 'a\u202eheader', 'a'.repeat(65)])
      expect(() => assertApiTokenName(name)).toThrow();
    const now = new Date('2026-11-04T00:00:00Z');
    expect(() => {
      assertApiTokenExpiry(new Date(now.getTime() + 60000), now);
    }).not.toThrow();
    expect(() => {
      assertApiTokenExpiry(new Date(now.getTime() + 90 * 86400000), now);
    }).not.toThrow();
    for (const expiry of [
      new Date(NaN),
      now,
      new Date(now.getTime() + 59999),
      new Date(now.getTime() + 90 * 86400000 + 1),
    ])
      expect(() => {
        assertApiTokenExpiry(expiry, now);
      }).toThrow();
  });
});
