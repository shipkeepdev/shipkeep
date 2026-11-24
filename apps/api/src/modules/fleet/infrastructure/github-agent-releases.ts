import { Injectable, Logger } from '@nestjs/common';

import {
  agentArchive,
  type AgentArchitecture,
  releaseFile,
  type ReleaseVersion,
} from '../domain/agent-upgrade';
import type { AgentRelease, AgentReleases } from '../application/ports';

/** The hosts a release download may go through: GitHub, then its release storage. */
const HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export const RELEASE_LIMITS = {
  timeoutMs: 20_000,
  maxRedirects: 5,
  /** `checksums.txt` lists a few dozen archives: about 3 KiB today. */
  checksumsBytes: 64 * 1024,
  /** A Sigstore bundle is about 10 KiB; the agent refuses one over 64 KiB. */
  bundleBytes: 64 * 1024,
} as const;

/** One GET, without following redirects; production uses `fetch`. */
export type ReleaseGet = (url: URL, signal: AbortSignal) => Promise<Response>;

const CHECKSUM_LINE = /^([0-9a-f]{64}) {2}(\S+)$/;
const BUNDLE_MEDIA_TYPE = /^application\/vnd\.dev\.sigstore\.bundle\.v0\.[0-9]+\+json$/;

/**
 * Reads an agent release from GitHub (ADR 0028): the archive's SHA-256 from the release's
 * `checksums.txt`, and its Sigstore bundle. Only HTTPS, only GitHub's release hosts, redirects
 * included, and bounded sizes. Nothing here is trusted: the agent verifies the archive against
 * the bundle and the bundle against Sigstore's root, offline.
 */
@Injectable()
export class GithubAgentReleases implements AgentReleases {
  private readonly logger = new Logger(GithubAgentReleases.name);

  constructor(
    private readonly get: ReleaseGet = (url, signal) => fetch(url, { redirect: 'manual', signal }),
  ) {}

  async find(
    version: ReleaseVersion,
    architecture: AgentArchitecture,
  ): Promise<AgentRelease | null> {
    const archive = agentArchive(version, architecture);
    try {
      const checksums = await this.download(
        releaseFile(version, 'checksums.txt'),
        RELEASE_LIMITS.checksumsBytes,
      );
      const sha256 = digestOf(new TextDecoder().decode(checksums), archive.name);
      const bundle = await this.download(
        releaseFile(version, `${archive.name}.sigstore.json`),
        RELEASE_LIMITS.bundleBytes,
      );
      if (!sha256 || !isBundle(bundle)) {
        this.logger.warn({ version: version.text, architecture }, 'agent release incomplete');
        return null;
      }
      return { url: archive.url, sha256, bundleJson: bundle };
    } catch (error: unknown) {
      // Only the kind of failure is logged: an error from the network carries no secret, but
      // nothing GitHub sent is repeated either.
      this.logger.warn(
        { version: version.text, architecture, failure: failureKind(error) },
        'agent release unavailable',
      );
      return null;
    }
  }

  private async download(address: string, limit: number): Promise<Uint8Array> {
    const signal = AbortSignal.timeout(RELEASE_LIMITS.timeoutMs);
    let url = allowed(new URL(address));
    for (let redirects = 0; ; redirects++) {
      const response = await this.get(url, signal);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects >= RELEASE_LIMITS.maxRedirects)
          throw new ReleaseReadError('redirect');
        url = allowed(new URL(location, url));
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new ReleaseReadError('status');
      }
      return readAtMost(response, limit, signal);
    }
  }
}

class ReleaseReadError extends Error {}

function allowed(url: URL): URL {
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    !HOSTS.has(url.hostname)
  )
    throw new ReleaseReadError('host');
  return url;
}

async function readAtMost(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > limit || !response.body) {
    await response.body?.cancel();
    throw new ReleaseReadError(response.body ? 'size' : 'body');
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    if (signal.aborted) {
      await reader.cancel();
      throw new ReleaseReadError('timeout');
    }
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ReleaseReadError('size');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The digest `checksums.txt` lists for `name`, once and only once; null otherwise. */
export function digestOf(checksums: string, name: string): string | null {
  const digests = checksums
    .split('\n')
    .map((line) => CHECKSUM_LINE.exec(line.replace(/\r$/, '')))
    .filter((match) => match?.[2] === name)
    .map((match) => match?.[1]);
  return digests.length === 1 ? (digests[0] ?? null) : null;
}

/** A JSON object that names a Sigstore bundle media type: the agent checks the rest. */
function isBundle(data: Uint8Array): boolean {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      BUNDLE_MEDIA_TYPE.test(String((parsed as Record<string, unknown>)['mediaType']))
    );
  } catch {
    return false;
  }
}

function failureKind(error: unknown): string {
  if (error instanceof ReleaseReadError) return error.message;
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  return 'network';
}
