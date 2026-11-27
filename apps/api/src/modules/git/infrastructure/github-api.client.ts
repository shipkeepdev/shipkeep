import { createSign } from 'node:crypto';

import { Secret } from '@shipkeep/domain';

import type { GithubApi } from '../application/ports';
import { MAX_CONFIG_BYTES } from '@shipkeep/config-schema';

import {
  appJwtClaims,
  branchHeadOf,
  type GithubRepository,
  installationTokenOf,
  repositoryOf,
  repositoryPageOf,
  type TokenScope,
  validCommit,
  validConfigPath,
  validFullName,
  validRepository,
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
 * scoped to what a call needs, the repositories an installation reaches, and a branch's head.
 * Only `api.github.com`, no redirect, bounded answers, and GitHub's text never repeated.
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
    method: 'GET' | 'POST' | 'DELETE',
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

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
