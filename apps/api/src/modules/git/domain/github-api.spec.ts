import { describe, expect, it } from 'vitest';

import {
  appJwtClaims,
  branchHeadOf,
  installationTokenOf,
  repositoryOf,
  repositoryPageOf,
  validCommit,
  validConfigPath,
  validRepository,
} from './github-api';

const repository = (overrides: Record<string, unknown> = {}) => ({
  id: 5,
  full_name: 'acme-corp/web',
  default_branch: 'main',
  private: true,
  ...overrides,
});

describe("GitHub's answers to the App (ADR 0031)", () => {
  it('issues the App JWT a minute back and for nine minutes', () => {
    expect(appJwtClaims(42, new Date('2026-11-25T12:00:00Z'))).toEqual({
      iat: 1795607940,
      exp: 1795608540,
      iss: '42',
    });
  });

  it('reads an installation token, wrapped, and nothing that is not one', () => {
    const read = installationTokenOf({
      token: 'ghs_fakeInstallationToken0123',
      expires_at: '2026-11-25T13:00:00Z',
    });
    expect(read?.token.expose()).toBe('ghs_fakeInstallationToken0123');
    expect(JSON.stringify(read)).not.toContain('ghs_');
    for (const bad of [
      null,
      { token: 'short', expires_at: '2026-11-25T13:00:00Z' },
      { token: 'ghs_fake token with spaces 00', expires_at: '2026-11-25T13:00:00Z' },
      { token: 'ghs_fakeInstallationToken0123', expires_at: 'soon' },
    ])
      expect(installationTokenOf(bad)).toBeUndefined();
  });

  it('reads a page of repositories, leaving out the entries it could not be', () => {
    expect(repositoryPageOf({ total_count: 1, repositories: [repository()] }, 9)).toEqual({
      total: 1,
      repositories: [
        {
          installationId: 9,
          id: 5,
          fullName: 'acme-corp/web',
          defaultBranch: 'main',
          private: true,
        },
      ],
    });
    for (const bad of [
      repository({ full_name: 'acme-corp/..' }),
      repository({ full_name: 'acme-corp/../etc' }),
      repository({ full_name: 'web' }),
      repository({ default_branch: '../main' }),
      repository({ default_branch: 'a//b' }),
      repository({ private: 'yes' }),
      repository({ id: 0 }),
    ])
      expect(
        repositoryPageOf(
          { total_count: 2, repositories: [bad, repository({ id: 6 })] },
          9,
        )?.repositories.map((entry) => entry.id),
      ).toEqual([6]);
    // Names Git allows that a narrow pattern would refuse.
    for (const branch of ['développement', 'release+2', 'fix#12', 'user@feature'])
      expect(
        repositoryPageOf(
          { total_count: 1, repositories: [repository({ default_branch: branch })] },
          9,
        )?.repositories,
      ).toHaveLength(1);
    expect(repositoryPageOf({ repositories: [] }, 9)).toBeUndefined();
  });

  it('reads the commit a branch points to', () => {
    expect(branchHeadOf({ commit: { sha: 'a'.repeat(40) } })).toBe('a'.repeat(40));
    expect(branchHeadOf({ commit: { sha: 'A'.repeat(40) } })).toBeUndefined();
    expect(branchHeadOf({})).toBeUndefined();
  });

  it('accepts the repository and branch names GitHub allows, and no path tricks', () => {
    expect(validRepository('acme-corp/web.site', 'feature/login-v2')).toBe(true);
    expect(validRepository('acme-corp/web', 'développement')).toBe(true);
    for (const [name, branch] of [
      ['acme/../x', 'main'],
      ['acme/..', 'main'],
      ['acme/.', 'main'],
      ['acme/web/extra', 'main'],
      ['acme/web', '/main'],
      ['acme/web', 'main/'],
      ['acme/web', 'a..b'],
      ['acme/web', 'a b'],
      ['acme/web', '.'],
      ['acme/web', 'x/.hidden'],
      ['acme/web', 'x.lock'],
      ['acme/web', 'a@{b'],
      ['acme/web', 'a:b'],
    ] as const)
      expect(validRepository(name, branch), `${name} ${branch}`).toBe(false);
  });

  it('reads one repository, and nothing GitHub could not have named', () => {
    expect(repositoryOf(repository(), 9)).toEqual({
      installationId: 9,
      id: 5,
      fullName: 'acme-corp/web',
      defaultBranch: 'main',
      private: true,
    });
    for (const broken of [
      repository({ id: 0 }),
      repository({ id: '5' }),
      repository({ full_name: 'acme-corp/..' }),
      repository({ default_branch: 'a..b' }),
      repository({ private: 'yes' }),
      null,
      [],
    ])
      expect(repositoryOf(broken, 9)).toBeUndefined();
  });

  it('accepts a full commit hash only', () => {
    expect(validCommit('0123456789abcdef0123456789abcdef01234567')).toBe(true);
    for (const commit of ['abc', 'A'.repeat(40), `${'a'.repeat(40)}&x=1`, 'main'])
      expect(validCommit(commit), commit).toBe(false);
  });

  it('accepts a relative path to a YAML file, and no path tricks', () => {
    for (const path of ['shipkeep.yml', 'deploy/prod.yaml', 'apps/api/shipkeep.yml', 'é/x.yml'])
      expect(validConfigPath(path), path).toBe(true);
    for (const path of [
      '',
      '/shipkeep.yml',
      '../shipkeep.yml',
      'a/../shipkeep.yml',
      './shipkeep.yml',
      'a//shipkeep.yml',
      'a\\shipkeep.yml',
      'shipkeep.yml/',
      'shipkeep.json',
      'shipkeep.yml\n',
      'shipkeep.yml?ref=main',
      `${'a'.repeat(252)}.yml`,
    ])
      expect(validConfigPath(path), JSON.stringify(path)).toBe(false);
  });
});
