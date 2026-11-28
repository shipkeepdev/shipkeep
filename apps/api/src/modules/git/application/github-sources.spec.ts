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
/** The change's name, as RepositoryConfigs makes it, its marker, and its pull request's branch. */
const ID = 'ab'.repeat(32);
const MARKER = `Shipkeep-Change: ${ID}`;
const BRANCH = `shipkeep/config-${ID.slice(0, 16)}`;
const change = (mode: 'commit' | 'pull_request'): RepositoryConfigChange => ({
  changeId: ID,
  blobSha: BLOB,
  text: 'version: 1\n',
  title: 'Change the configuration of web',
  body: 'Made in Shipkeep.',
  mode,
});

/**
 * A repository whose file has blob BLOB at HEAD, on `main`. `refuse` makes GitHub refuse writes to
 * a branch; `existing` are branches there already, at a commit; `messages` are commits' messages;
 * `open` the pull requests open from a branch; `refuseBranch` makes GitHub refuse a new branch.
 */
function world(
  options: {
    refuse?: string;
    blobAfterRefusal?: string;
    existing?: Record<string, string>;
    messages?: Record<string, string>;
    open?: Record<string, { number: number; url: string }>;
    refuseBranch?: boolean;
  } = {},
) {
  const writes: { branch: string; message: string; blobSha: string }[] = [];
  const branches: string[] = [];
  const pulls: { head: string; base: string; title: string }[] = [];
  const scopes: TokenScope[] = [];
  const revoked: string[] = [];
  const heads: Record<string, string> = { main: HEAD, ...options.existing };
  const messages: Record<string, string> = { ...options.messages };
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
    branchHead: (_token: Secret, _fullName: string, branch: string) =>
      Promise.resolve(heads[branch]),
    fileAt: (_token: Secret, _fullName: string, _path: string, ref: string) =>
      Promise.resolve({
        blobSha: refused && ref === 'main' ? (options.blobAfterRefusal ?? BLOB) : BLOB,
        text: 'version: 1\nname: web\n',
      }),
    createBranch: (_token: Secret, _fullName: string, branch: string, commit: string) => {
      expect(commit).toBe(HEAD);
      if (options.refuseBranch) return Promise.resolve('refused' as const);
      if (heads[branch]) return Promise.resolve(false);
      heads[branch] = commit;
      branches.push(branch);
      return Promise.resolve(true);
    },
    commitMessage: (_token: Secret, _fullName: string, commit: string) =>
      Promise.resolve(messages[commit]),
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
      heads[file.branch] = COMMIT;
      messages[COMMIT] = file.message;
      return Promise.resolve({
        commitSha: COMMIT,
        url: `https://github.com/acme-corp/web/commit/${COMMIT}`,
      });
    },
    openPullRequestFrom: (_token: Secret, _fullName: string, head: string) =>
      Promise.resolve(options.open?.[head]),
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
        message: `Change the configuration of web\n\nMade in Shipkeep.\n\n${MARKER}`,
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

  it('opens a pull request from a branch named after the change in pull request mode', async () => {
    const w = world();
    const written = await w.sources.writeConfig('org', location, change('pull_request'));
    expect(written).toEqual({
      via: 'pull_request',
      commitSha: COMMIT,
      branch: BRANCH,
      number: 12,
      url: 'https://github.com/acme-corp/web/pull/12',
    });
    expect(w.branches).toEqual([BRANCH]);
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

  // #214 review: a retry after an answer that never arrived finds what the first attempt wrote.
  it('takes up the pull request of an earlier attempt instead of opening another', async () => {
    const earlier = 'f'.repeat(40);
    const pull = { number: 7, url: 'https://github.com/acme-corp/web/pull/7' };
    const w = world({
      existing: { [BRANCH]: earlier },
      messages: { [earlier]: `Change the configuration of web\n\n${MARKER}` },
      open: { [BRANCH]: pull },
    });
    expect(await w.sources.writeConfig('org', location, change('pull_request'))).toEqual({
      via: 'pull_request',
      commitSha: earlier,
      branch: BRANCH,
      ...pull,
    });
    expect(w.writes).toEqual([]);
    expect(w.pulls).toEqual([]);
    // Its pull request closed meanwhile: another is opened from the same branch, not written again.
    const closed = world({
      existing: { [BRANCH]: earlier },
      messages: { [earlier]: `Change the configuration of web\n\n${MARKER}` },
    });
    await closed.sources.writeConfig('org', location, change('pull_request'));
    expect(closed.writes).toEqual([]);
    expect(closed.pulls).toEqual([
      { head: BRANCH, base: 'main', title: 'Change the configuration of web' },
    ]);
  });

  it('writes on the branch an earlier attempt made and left as it was', async () => {
    const w = world({ existing: { [BRANCH]: HEAD } });
    await w.sources.writeConfig('org', location, change('pull_request'));
    expect(w.writes.map((write) => write.branch)).toEqual([BRANCH]);
    expect(w.pulls).toHaveLength(1);
  });

  it('writes nothing over a branch of that name that holds something else', async () => {
    const other = 'd'.repeat(40);
    const w = world({
      existing: { [BRANCH]: other },
      messages: { [other]: "Someone else's commit" },
    });
    await expect(
      w.sources.writeConfig('org', location, change('pull_request')),
    ).rejects.toMatchObject({ code: 'repository_refused_change' });
    expect(w.writes).toEqual([]);
    expect(w.pulls).toEqual([]);
  });

  it('answers a refused branch as a refused change, not as GitHub unavailable', async () => {
    const w = world({ refuseBranch: true });
    await expect(
      w.sources.writeConfig('org', location, change('pull_request')),
    ).rejects.toMatchObject({ code: 'repository_refused_change' });
    expect(w.writes).toEqual([]);
    expect(w.revoked).toHaveLength(1);
  });

  it('finds the commit of an earlier attempt at the head of the branch, with a read token', async () => {
    const committed = world({
      existing: { main: COMMIT },
      messages: { [COMMIT]: `Change the configuration of web\n\nMade in Shipkeep.\n\n${MARKER}` },
    });
    expect(await committed.sources.writtenChange('org', location, ID)).toEqual({
      via: 'commit',
      commitSha: COMMIT,
      url: `https://github.com/acme-corp/web/commit/${COMMIT}`,
    });
    expect(committed.scopes.map((scope) => scope.permissions)).toEqual([
      { contents: 'read', metadata: 'read' },
    ]);
    expect(committed.revoked).toHaveLength(1);
    // A head another change made, or another name, is not this change.
    const other = world({ messages: { [HEAD]: 'Fix the port' } });
    expect(await other.sources.writtenChange('org', location, ID)).toBeUndefined();
    expect(await committed.sources.writtenChange('org', location, 'cd'.repeat(32))).toBeUndefined();
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
