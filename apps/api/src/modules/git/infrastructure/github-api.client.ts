import { createSign } from 'node:crypto';

import { Secret } from '@shipkeep/domain';

import type { GithubApi } from '../application/ports';
import {
  appJwtClaims,
  branchHeadOf,
  type GithubRepository,
  installationTokenOf,
  repositoryPageOf,
  type TokenScope,
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
  ): Promise<{ token: Secret; expiresAt: Date }> {
    const answer = await this.call(
      'POST',
      `/app/installations/${String(installationId)}/access_tokens`,
      jwt,
      {
        ...(scope.repositoryIds ? { repository_ids: scope.repositoryIds } : {}),
        permissions: scope.permissions,
      },
    );
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

  async revoke(token: Secret): Promise<void> {
    // Best effort: a token that is not revoked still expires within the hour.
    await this.call('DELETE', '/installation/token', token).catch(() => undefined);
  }

  private async call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    credential: Secret,
    body?: object,
  ): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await this.send(`${API}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          accept: 'application/vnd.github+json',
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
    if (response.status === 204 || response.status === 404) {
      await discardGithubAnswer(response);
      return { status: response.status, body: undefined };
    }
    if (response.status < 200 || response.status >= 300) {
      await discardGithubAnswer(response);
      throw githubUnavailable();
    }
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
