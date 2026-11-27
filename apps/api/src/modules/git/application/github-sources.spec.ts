import { Secret } from '@shipkeep/domain';
import { describe, expect, it } from 'vitest';

import type { RepositoryConfigChange } from '../../apps/application/ports';
import type { TokenScope } from '../domain/github-api';

import { GithubSources } from './github-sources';
import type { GitTransaction, GithubApi, GithubAppStore } from './ports';

const HEAD = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);
const COMMIT = 'c'.repeat(40);
const location = {
  installationId: 7,
  repositoryId: 70,
  branch: 'main',
  configPath: 'shipkeep.yml',
};
const change = (mode: 'commit' | 'pull_request'): RepositoryConfigChange => ({
  blobSha: BLOB,
  text: 'version: 1\n',
  title: 'Change the configuration of web',
  body: 'Made in Shipkeep.',
  mode,
});

/** A repository whose file has blob BLOB at HEAD; `refuse` makes GitHub refuse writes to a branch. */
function world(
  options: { refuse?: string; blobAfterRefusal?: string; takenBranches?: number } = {},
) {
  const writes: { branch: string; message: string; blobSha: string }[] = [];
  const branches: string[] = [];
  const pulls: { head: string; base: string; title: string }[] = [];
  const scopes: TokenScope[] = [];
  const revoked: string[] = [];
  let taken = options.takenBranches ?? 0;
  let refused = false;
  const github = {
    appJwt: () => new Secret('jwt'),
    installationToken: (_jwt: Secret, _installation: number, scope: TokenScope) => {
      scopes.push(scope);
      return Promise.resolve({ token: new Secret('ghs_token_write'), expiresAt: new Date() });
    },
    repository: () =>
      Promise.resolve({
        installationId: 7,
        id: 70,
        fullName: 'acme-corp/web',
        defaultBranch: 'main',
        private: true,
      }),
    branchHead: () => Promise.resolve(HEAD),
    fileAt: (_token: Secret, _fullName: string, _path: string, ref: string) =>
      Promise.resolve({
        blobSha: refused && ref === 'main' ? (options.blobAfterRefusal ?? BLOB) : BLOB,
        text: 'version: 1\nname: web\n',
      }),
    createBranch: (_token: Secret, _fullName: string, branch: string, commit: string) => {
      expect(commit).toBe(HEAD);
      if (taken > 0) {
        taken--;
        return Promise.resolve(false);
      }
      branches.push(branch);
      return Promise.resolve(true);
    },
    writeFile: (
      _token: Secret,
      _fullName: string,
      file: { branch: string; message: string; blobSha: string },
    ) => {
      if (file.branch === options.refuse) {
        refused = true;
        return Promise.resolve('refused' as const);
      }
      writes.push({ branch: file.branch, message: file.message, blobSha: file.blobSha });
      return Promise.resolve({
        commitSha: COMMIT,
        url: `https://github.com/acme-corp/web/commit/${COMMIT}`,
      });
    },
    openPullRequest: (
      _token: Secret,
      _fullName: string,
      request: { head: string; base: string; title: string },
    ) => {
      pulls.push({ head: request.head, base: request.base, title: request.title });
      return Promise.resolve({ number: 12, url: 'https://github.com/acme-corp/web/pull/12' });
    },
    revoke: (token: Secret) => {
      revoked.push(token.expose());
      return Promise.resolve(true);
    },
  } as unknown as GithubApi;
  const store = {
    credentials: () => Promise.resolve({ appId: 1, privateKey: new Secret('key') }),
    activeInstallations: () => Promise.resolve([7]),
  } as unknown as GithubAppStore;
  const transaction = {
    runTenant: (_org: string, work: () => Promise<unknown>) => work(),
  } as unknown as GitTransaction;
  return {
    sources: new GithubSources(store, github, transaction),
    writes,
    branches,
    pulls,
    scopes,
    revoked,
  };
}

describe("a change of a Git application's file, written to its repository (#214)", () => {
  it('commits on the branch in commit mode, with a write token given back', async () => {
    const w = world();
    expect(await w.sources.writeConfig('org', location, change('commit'))).toEqual({
      via: 'commit',
      commitSha: COMMIT,
      url: `https://github.com/acme-corp/web/commit/${COMMIT}`,
    });
    expect(w.writes).toEqual([
      {
        branch: 'main',
        message: 'Change the configuration of web\n\nMade in Shipkeep.',
        blobSha: BLOB,
      },
    ]);
    expect(w.pulls).toEqual([]);
    expect(w.scopes).toEqual([
      {
        repositoryIds: [70],
        permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      },
    ]);
    expect(w.revoked).toEqual(['ghs_token_write']);
  });

  it('opens a pull request from a branch of its own in pull request mode', async () => {
    const w = world();
    const written = await w.sources.writeConfig('org', location, change('pull_request'));
    expect(written).toMatchObject({
      via: 'pull_request',
      number: 12,
      url: 'https://github.com/acme-corp/web/pull/12',
    });
    expect(w.branches).toHaveLength(1);
    expect(w.branches[0]).toMatch(/^shipkeep\/config-[0-9a-f]{12}$/);
    expect(w.writes.map((write) => write.branch)).toEqual(w.branches);
    expect(w.pulls).toEqual([
      { head: w.branches[0], base: 'main', title: 'Change the configuration of web' },
    ]);
  });

  it('makes a pull request of a commit a protected branch refuses, on an unchanged file', async () => {
    const w = world({ refuse: 'main' });
    expect(await w.sources.writeConfig('org', location, change('commit'))).toMatchObject({
      via: 'pull_request',
      number: 12,
    });
    expect(w.writes.map((write) => write.branch)).toEqual(w.branches);
  });

  it('writes nothing over a file changed since the change was made', async () => {
    // Refused because the file changed meanwhile: no pull request either.
    const raced = world({ refuse: 'main', blobAfterRefusal: 'd'.repeat(40) });
    await expect(
      raced.sources.writeConfig('org', location, change('commit')),
    ).rejects.toMatchObject({ code: 'config_file_changed' });
    expect(raced.pulls).toEqual([]);
    expect(raced.revoked).toHaveLength(1);
    // Changed before anything was written.
    const stale = world();
    await expect(
      stale.sources.writeConfig('org', location, {
        ...change('pull_request'),
        blobSha: 'e'.repeat(40),
      }),
    ).rejects.toMatchObject({ code: 'config_file_changed' });
    expect(stale.writes).toEqual([]);
    expect(stale.branches).toEqual([]);
  });

  it('tries other branch names when one is taken, and gives up after three', async () => {
    const once = world({ takenBranches: 1 });
    await once.sources.writeConfig('org', location, change('pull_request'));
    expect(once.branches).toHaveLength(1);
    const always = world({ takenBranches: 3 });
    await expect(
      always.sources.writeConfig('org', location, change('pull_request')),
    ).rejects.toMatchObject({ code: 'repository_refused_change' });
    expect(always.writes).toEqual([]);
  });

  it('refuses a location Git does not allow before any token is asked', async () => {
    const w = world();
    for (const bad of [
      { ...location, branch: 'a..b' },
      { ...location, configPath: '../shipkeep.yml' },
    ])
      await expect(w.sources.writeConfig('org', bad, change('commit'))).rejects.toMatchObject({
        code: 'invalid_repository_location',
      });
    expect(w.scopes).toEqual([]);
  });
});
