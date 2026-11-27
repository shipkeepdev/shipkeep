import { createSign } from 'node:crypto';

import { Secret } from '@shipkeep/domain';

import type { GithubApi } from '../application/ports';
import { MAX_CONFIG_BYTES } from '@shipkeep/config-schema';

import {
  appJwtClaims,
  branchHeadOf,
  type GithubRepository,
  installationTokenOf,
  type OpenedPullRequest,
  openedPullRequestOf,
  type RepositoryFile,
  repositoryFileOf,
  repositoryOf,
  repositoryPageOf,
  type TokenScope,
  validBranch,
  validCommit,
  validConfigPath,
  validFullName,
  validGitText,
  validRepository,
  type WrittenCommit,
  writtenCommitOf,
} from '../domain/github-api';

import { discardGithubAnswer, githubUnavailable, readGithubAnswer } from './github-http';

const API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;
/** A page of 100 repositories is a few hundred kilobytes: GitHub sends many links for each. */
const MAX_ANSWER = 2 << 20;
const PAGE = 100;

/** One request, without following redirects; production uses `fetch`. */
export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * GitHub's REST API for an organization's App (ADR 0031): the App's JWT, installation tokens
 * scoped to what a call needs, the repositories an installation reaches, a branch's head, a file,
 * and the writes of a configuration change (#214): a branch, a commit of one file, a pull request.
 * Only `api.github.com`, no redirect, bounded answers, and GitHub's text never repeated. Every
 * name is checked before it goes into a URL or a body.
 */
export class GithubApiClient implements GithubApi {
  constructor(private readonly send: GithubFetch = (url, init) => fetch(url, init)) {}

  appJwt(appId: number, privateKey: Secret, now: Date): Secret {
    const header = base64url({ alg: 'RS256', typ: 'JWT' });
    const claims = base64url(appJwtClaims(appId, now));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    try {
      return new Secret(`${header}.${claims}.${signer.sign(privateKey.expose(), 'base64url')}`);
    } catch {
      // A key that does not sign is the stored App's problem, not the caller's request.
      throw githubUnavailable();
    }
  }

  async installationToken(
    jwt: Secret,
    installationId: number,
    scope: TokenScope,
  ): Promise<{ token: Secret; expiresAt: Date } | undefined> {
    const answer = await this.call(
      'POST',
      `/app/installations/${String(installationId)}/access_tokens`,
      jwt,
      {
        ...(scope.repositoryIds ? { repository_ids: scope.repositoryIds } : {}),
        permissions: scope.permissions,
      },
      'json',
      // GitHub answers 422 when a repository asked for is not in the installation.
      scope.repositoryIds ? [422] : [],
    );
    if (answer.status === 422) return undefined;
    const token = answer.status === 201 ? installationTokenOf(answer.body) : undefined;
    if (!token) throw githubUnavailable();
    return token;
  }

  async repositories(
    token: Secret,
    installationId: number,
    limit: number,
  ): Promise<{ repositories: GithubRepository[]; truncated: boolean }> {
    const repositories: GithubRepository[] = [];
    for (let page = 1; repositories.length < limit; page++) {
      const answer = await this.call(
        'GET',
        `/installation/repositories?per_page=${String(PAGE)}&page=${String(page)}`,
        token,
      );
      const read =
        answer.status === 200 ? repositoryPageOf(answer.body, installationId) : undefined;
      if (!read) throw githubUnavailable();
      repositories.push(...read.repositories);
      if (read.repositories.length < PAGE || repositories.length >= read.total)
        return {
          repositories: repositories.slice(0, limit),
          truncated: repositories.length > limit,
        };
    }
    return { repositories: repositories.slice(0, limit), truncated: true };
  }

  async branchHead(token: Secret, fullName: string, branch: string): Promise<string | undefined> {
    // Checked here too: a `.` or `..` segment would be resolved to another resource.
    if (!validRepository(fullName, branch)) return undefined;
    const answer = await this.call(
      'GET',
      `/repos/${fullName.split('/').map(encodeURIComponent).join('/')}/branches/${encodeURIComponent(branch)}`,
      token,
    );
    if (answer.status === 404) return undefined;
    const sha = answer.status === 200 ? branchHeadOf(answer.body) : undefined;
    if (!sha) throw githubUnavailable();
    return sha;
  }

  async repository(
    token: Secret,
    installationId: number,
    repositoryId: number,
  ): Promise<GithubRepository | undefined> {
    const answer = await this.call('GET', `/repositories/${String(repositoryId)}`, token);
    if (answer.status === 404) return undefined;
    const repository =
      answer.status === 200 ? repositoryOf(answer.body, installationId) : undefined;
    // An answer about another repository is not this one's.
    if (!repository || repository.id !== repositoryId) throw githubUnavailable();
    return repository;
  }

  async file(
    token: Secret,
    fullName: string,
    path: string,
    commit: string,
  ): Promise<string | undefined> {
    // Checked here too: each part becomes a URL path segment, and the commit a query value.
    if (!validFullName(fullName) || !validConfigPath(path) || !validCommit(commit))
      return undefined;
    const segments = [...fullName.split('/'), 'contents', ...path.split('/')]
      .map(encodeURIComponent)
      .join('/');
    const answer = await this.call(
      'GET',
      `/repos/${segments}?ref=${commit}`,
      token,
      undefined,
      'raw',
    );
    if (answer.status === 404) return undefined;
    if (answer.status !== 200 || typeof answer.body !== 'string') throw githubUnavailable();
    return answer.body;
  }

  async fileAt(
    token: Secret,
    fullName: string,
    path: string,
    ref: string,
  ): Promise<RepositoryFile | undefined> {
    if (
      !validFullName(fullName) ||
      !validConfigPath(path) ||
      !(validCommit(ref) || validBranch(ref))
    )
      return undefined;
    const answer = await this.call(
      'GET',
      `/repos/${contentsPath(fullName, path)}?ref=${encodeURIComponent(ref)}`,
      token,
    );
    if (answer.status === 404) return undefined;
    const file =
      answer.status === 200 ? repositoryFileOf(answer.body, MAX_CONFIG_BYTES) : undefined;
    if (!file) throw githubUnavailable();
    return file;
  }

  async createBranch(
    token: Secret,
    fullName: string,
    branch: string,
    commit: string,
  ): Promise<boolean> {
    if (!validRepository(fullName, branch) || !validCommit(commit)) throw githubUnavailable();
    // GitHub answers 422 when the reference exists already.
    const answer = await this.call(
      'POST',
      `/repos/${repositoryPath(fullName)}/git/refs`,
      token,
      { ref: `refs/heads/${branch}`, sha: commit },
      'json',
      [422],
    );
    if (answer.status === 422) return false;
    if (answer.status !== 201) throw githubUnavailable();
    return true;
  }

  async writeFile(
    token: Secret,
    fullName: string,
    change: {
      readonly branch: string;
      readonly path: string;
      readonly text: string;
      readonly blobSha: string;
      readonly message: string;
    },
  ): Promise<WrittenCommit | 'refused'> {
    if (
      !validRepository(fullName, change.branch) ||
      !validConfigPath(change.path) ||
      !validCommit(change.blobSha) ||
      !validGitText(change.message, 'text') ||
      new TextEncoder().encode(change.text).length > MAX_CONFIG_BYTES
    )
      throw githubUnavailable();
    // 409: the blob is no longer the file's, or a rule refuses the push; 422: GitHub refused the
    // change itself, as a protected branch does.
    const answer = await this.call(
      'PUT',
      `/repos/${contentsPath(fullName, change.path)}`,
      token,
      {
        message: change.message,
        content: Buffer.from(change.text, 'utf8').toString('base64'),
        sha: change.blobSha,
        branch: change.branch,
      },
      'json',
      [409, 422],
    );
    if (answer.status === 409 || answer.status === 422) return 'refused';
    const written = answer.status === 200 ? writtenCommitOf(answer.body) : undefined;
    if (!written) throw githubUnavailable();
    return written;
  }

  async openPullRequest(
    token: Secret,
    fullName: string,
    request: {
      readonly head: string;
      readonly base: string;
      readonly title: string;
      readonly body: string;
    },
  ): Promise<OpenedPullRequest | 'refused'> {
    if (
      !validRepository(fullName, request.head) ||
      !validBranch(request.base) ||
      !validGitText(request.title, 'title') ||
      !validGitText(request.body, 'text')
    )
      throw githubUnavailable();
    // 422: GitHub refused it, as when a pull request of that branch is open already.
    const answer = await this.call(
      'POST',
      `/repos/${repositoryPath(fullName)}/pulls`,
      token,
      { title: request.title, head: request.head, base: request.base, body: request.body },
      'json',
      [422],
    );
    if (answer.status === 422) return 'refused';
    const opened = answer.status === 201 ? openedPullRequestOf(answer.body) : undefined;
    if (!opened) throw githubUnavailable();
    return opened;
  }

  async revoke(token: Secret): Promise<boolean> {
    // 401: the token is no longer valid, which is what was asked. A token not revoked still
    // expires within the hour; the caller decides whether to ask again.
    try {
      const { status } = await this.call(
        'DELETE',
        '/installation/token',
        token,
        undefined,
        'json',
        [401],
      );
      return status === 204 || status === 401 || status === 404;
    } catch {
      return false;
    }
  }

  /**
   * One call. A `raw` answer is a file's bytes as text, read up to the largest shipkeep.yml;
   * any other is JSON, read up to `MAX_ANSWER`.
   */
  private async call(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    credential: Secret,
    body?: object,
    kind: 'json' | 'raw' = 'json',
    /** Statuses answered without a body instead of being GitHub unavailable. */
    expected: readonly number[] = [],
  ): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await this.send(`${API}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          accept: kind === 'raw' ? 'application/vnd.github.raw' : 'application/vnd.github+json',
          authorization: `Bearer ${credential.expose()}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'shipkeep',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw githubUnavailable();
    }
    if (response.status === 204 || response.status === 404 || expected.includes(response.status)) {
      await discardGithubAnswer(response);
      return { status: response.status, body: undefined };
    }
    if (response.status < 200 || response.status >= 300) {
      await discardGithubAnswer(response);
      throw githubUnavailable();
    }
    if (kind === 'raw')
      return { status: response.status, body: await readGithubAnswer(response, MAX_CONFIG_BYTES) };
    const text = await readGithubAnswer(response, MAX_ANSWER);
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      throw githubUnavailable();
    }
  }
}

/** `owner/name`, each part a URL path segment. */
function repositoryPath(fullName: string): string {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

/** `owner/name/contents/path`, each part a URL path segment. */
function contentsPath(fullName: string, path: string): string {
  return [...fullName.split('/'), 'contents', ...path.split('/')].map(encodeURIComponent).join('/');
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
