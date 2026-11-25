import type { GithubManifests } from '../application/ports';
import { flowInvalid } from '../domain/github-app';

import { discardGithubAnswer, githubUnavailable, readGithubAnswer } from './github-http';

const API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;
/** GitHub's answer holds the App and its key: a few kilobytes. */
const MAX_ANSWER = 64 * 1024;

/** One POST, without following redirects; production uses `fetch`. */
export type ManifestPost = (url: string, init: RequestInit) => Promise<Response>;

/**
 * GitHub's manifest conversion (ADR 0031): `POST /app-manifests/{code}/conversions` answers the App
 * GitHub created with its private key, webhook secret and client secret. The code is single use
 * and authenticates the call by itself.
 */
export class GithubManifestClient implements GithubManifests {
  constructor(private readonly post: ManifestPost = (url, init) => fetch(url, init)) {}

  async convert(code: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.post(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'shipkeep',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw githubUnavailable();
    }
    // A code GitHub does not know, or no more: the owner starts again.
    if (response.status === 404 || response.status === 422) {
      await discardGithubAnswer(response);
      throw flowInvalid();
    }
    if (response.status !== 201) {
      await discardGithubAnswer(response);
      throw githubUnavailable();
    }
    const text = await readGithubAnswer(response, MAX_ANSWER);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw githubUnavailable();
    }
  }
}
