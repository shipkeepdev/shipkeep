import { createHash } from 'node:crypto';

import { InvalidInputError, Secret } from '@shipkeep/domain';

import type { RegistryLogin } from '../../../registries/domain/registry-credential';
import type { ImageResolver } from '../../application/ports';
import {
  credentialServer,
  type ImageReference,
  parseImageReference,
  pinnedReference,
} from '../../domain/image-reference';

import {
  assertRegistryUrl,
  GuardedHttps,
  publicRegistryHost,
  RegistryAccessError,
  type RegistryHostCheck,
  type RegistryRequest,
  type RegistryResponse,
  type RegistryTransport,
} from './guarded-https';

/** Index and manifest media types: a multi-arch index digest lets each node pull its platform. */
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_TOKEN = 8192;

/**
 * Resolves image tags to digests with the registry HTTP API v2 (ADR 0012): anonymously, or with
 * the credentials the organization stored for the image's registry (ADR 0019). Every request
 * goes through the SSRF-guarded transport, and a reference already pinned by digest passes the
 * same address policy. Errors name the registry and the status, never tokens or passwords.
 */
export class RegistryResolver implements ImageResolver {
  private readonly transport: RegistryTransport;

  private readonly checkHost: RegistryHostCheck;

  constructor(transport?: RegistryTransport, checkHost?: RegistryHostCheck) {
    this.transport = transport ?? new GuardedHttps();
    this.checkHost = checkHost ?? publicRegistryHost();
  }

  async resolve(reference: string, login?: RegistryLogin): Promise<string> {
    const image = parseImageReference(reference);
    // Credentials of another registry are never used, whatever the caller passed.
    const account = login && login.server === credentialServer(image) ? login : undefined;
    try {
      if (image.digest) {
        // Nothing to look up, but the node will pull from this registry: a digest must not be a
        // way around the address policy that a tag goes through.
        await this.checkHost(image.registry);
        return pinnedReference(image, image.digest);
      }
      return pinnedReference(image, await this.digestOf(image, account));
    } catch (error: unknown) {
      if (error instanceof InvalidInputError) throw error;
      throw failure(
        image,
        error instanceof RegistryAccessError ? error.message : 'registry request failed',
      );
    }
  }

  private async digestOf(image: ImageReference, login: RegistryLogin | undefined): Promise<string> {
    const url = new URL(
      `https://${image.registry}/v2/${image.repository}/manifests/${image.tag ?? 'latest'}`,
    );
    const headers: Record<string, string> = { Accept: ACCEPT };
    // The first request carries nothing: credentials are sent only once the registry asks.
    let response = await this.request(url, { method: 'HEAD', headers });
    if (response.status === 401) {
      const challenge = response.headers['www-authenticate'];
      if (/^Basic(\s|$)/i.test(challenge ?? '')) {
        if (!login) throw failure(image, PRIVATE);
        headers['Authorization'] = basic(login);
      } else {
        const token = await this.token(image, challenge, login);
        headers['Authorization'] = `Bearer ${token.expose()}`;
      }
      response = await this.request(url, { method: 'HEAD', headers });
    }
    if (response.status === 401 || response.status === 403)
      throw failure(image, login ? REFUSED : PRIVATE);
    if (response.status === 404) throw failure(image, 'the image or tag does not exist');
    if (response.status !== 200)
      throw failure(image, `the registry answered ${String(response.status)}`);
    const digest = response.headers['docker-content-digest'];
    if (digest !== undefined) {
      if (!DIGEST.test(digest)) throw failure(image, 'the registry sent an invalid digest');
      return digest;
    }
    // Some registries omit the header on HEAD: hash the manifest exactly as served.
    const manifest = await this.request(url, { method: 'GET', headers });
    if (manifest.status !== 200)
      throw failure(image, `the registry answered ${String(manifest.status)}`);
    return `sha256:${createHash('sha256').update(manifest.body).digest('hex')}`;
  }

  /** Every URL is checked here too, whatever the transport does (defense in depth). */
  private request(url: URL, init: RegistryRequest): Promise<RegistryResponse> {
    assertRegistryUrl(url);
    return this.transport.request(url, init);
  }

  /**
   * Pull token from the realm the registry names (Docker token protocol): anonymous, or asked
   * with the stored credentials. The realm is the registry's own choice, as for `docker login`,
   * and it goes through the same guarded transport: HTTPS, public addresses, no redirect.
   */
  private async token(
    image: ImageReference,
    challenge: string | undefined,
    login: RegistryLogin | undefined,
  ): Promise<Secret> {
    const parameters = bearerChallenge(challenge);
    const realm = parameters?.get('realm');
    if (!realm) throw failure(image, 'the registry requires an unsupported authentication');
    let url: URL;
    try {
      url = new URL(realm);
    } catch {
      throw failure(image, 'the registry named an invalid token service');
    }
    const service = parameters?.get('service');
    if (service) url.searchParams.set('service', service);
    url.searchParams.set('scope', `repository:${image.repository}:pull`);
    const response = await this.request(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...(login ? { Authorization: basic(login) } : {}) },
    });
    if (login && (response.status === 401 || response.status === 403))
      throw failure(image, REFUSED);
    if (response.status !== 200)
      throw failure(image, `the token service answered ${String(response.status)}`);
    let body: unknown;
    try {
      body = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw failure(image, 'the token service sent invalid JSON');
    }
    const value =
      typeof body === 'object' && body !== null
        ? ((body as Record<string, unknown>)['token'] ??
          (body as Record<string, unknown>)['access_token'])
        : undefined;
    if (typeof value !== 'string' || !value || value.length > MAX_TOKEN || /[\s,]/.test(value))
      throw failure(image, 'the token service sent no usable token');
    return new Secret(value);
  }
}

const REFUSED = 'the registry refused the stored credentials';
const PRIVATE =
  'the registry refused anonymous access; store credentials for this registry if the image is private';

/** HTTP Basic credentials, built at the point of use and never logged. */
function basic(login: RegistryLogin): string {
  return `Basic ${Buffer.from(`${login.username}:${login.password.expose()}`, 'utf8').toString('base64')}`;
}

/** Parses `Bearer realm="…",service="…",scope="…"`; undefined for other schemes. */
export function bearerChallenge(header: string | undefined): Map<string, string> | undefined {
  if (!header || header.length > 2048 || !/^Bearer\s+/i.test(header)) return undefined;
  const parameters = new Map<string, string>();
  for (const match of header.replace(/^Bearer\s+/i, '').matchAll(/([a-z_]+)="([^"]*)"/gi)) {
    const [, key = '', value = ''] = match;
    if (key) parameters.set(key.toLowerCase(), value);
  }
  return parameters;
}

function failure(image: ImageReference, reason: string): InvalidInputError {
  return new InvalidInputError(
    'image_resolution_failed',
    `Could not resolve ${image.name}:${image.tag ?? 'latest'} on ${image.registry}: ${reason}.`,
  );
}
