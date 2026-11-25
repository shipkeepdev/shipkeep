import { ServiceUnavailableException } from '@nestjs/common';

import type { GithubManifests } from '../application/ports';
import { flowInvalid } from '../domain/github-app';

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
      throw unavailable();
    }
    // A code GitHub does not know, or no more: the owner starts again.
    if (response.status === 404 || response.status === 422) {
      await discard(response);
      throw flowInvalid();
    }
    if (response.status !== 201) {
      await discard(response);
      throw unavailable();
    }
    const text = await bounded(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw unavailable();
    }
  }
}

/** The body, read up to MAX_ANSWER bytes; any failure, or more, is GitHub being unavailable. */
async function bounded(response: Response): Promise<string> {
  // Node's fetch types its body loosely: it is a stream of bytes.
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ANSWER) break;
      chunks.push(value);
    }
  } catch {
    throw unavailable();
  }
  if (size > MAX_ANSWER) {
    await reader.cancel().catch(() => undefined);
    throw unavailable();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** GitHub's text and status stay private: the caller learns that it could not be reached. */
function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException('GitHub could not be reached. Try again in a moment.');
}
