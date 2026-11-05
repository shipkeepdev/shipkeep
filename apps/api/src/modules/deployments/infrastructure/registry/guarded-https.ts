import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import { isPublicAddress } from './public-address';

export interface RegistryRequest {
  readonly method: 'GET' | 'HEAD';
  readonly headers: Readonly<Record<string, string>>;
}
export interface RegistryResponse {
  readonly status: number;
  /** Lower-case header names; repeated headers are joined by `, `. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Buffer;
}
/** Outbound HTTP for registry calls; the production implementation is `GuardedHttps`. */
export interface RegistryTransport {
  request(url: URL, init: RegistryRequest): Promise<RegistryResponse>;
}

export class RegistryAccessError extends Error {}

export const REGISTRY_LIMITS = { timeoutMs: 10_000, maxBodyBytes: 1024 * 1024 } as const;

type Resolver = (
  hostname: string,
  options: { all: true; verbatim: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * DNS lookup for registry sockets: refuses the host when any of its addresses is not public, so a
 * name cannot point the control plane at internal services (SSRF), and the socket connects only to
 * an address this function vetted (no second resolution to rebind).
 */
export function publicLookup(resolve: Resolver = dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
        callback(new RegistryAccessError('registry host resolves to a non-public address'), '', 0);
        return;
      }
      const [first] = addresses;
      if (options.all) callback(null, addresses);
      else callback(null, first.address, first.family);
    });
  };
}

/** Checks what can be checked before connecting: HTTPS, no credentials, public IP literals. */
export function assertRegistryUrl(url: URL): void {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || !host)
    throw new RegistryAccessError('registry URLs must be plain https URLs');
  if (isIP(host) && !isPublicAddress(host))
    throw new RegistryAccessError('registry address is not public');
}

/** HTTPS with SSRF guards, no redirects, and bounded time and response size. */
export class GuardedHttps implements RegistryTransport {
  constructor(
    private readonly lookup: LookupFunction = publicLookup(),
    private readonly limits = REGISTRY_LIMITS,
  ) {}

  request(url: URL, init: RegistryRequest): Promise<RegistryResponse> {
    assertRegistryUrl(url);
    return new Promise((resolve, reject) => {
      const fail = (error: Error): void => {
        // Socket and TLS messages may echo hosts or URLs; keep the reason generic unless ours.
        if (error instanceof RegistryAccessError) reject(error);
        else if (error.name === 'AbortError')
          reject(new RegistryAccessError('registry request timed out'));
        else reject(new RegistryAccessError('registry request failed'));
      };
      const outgoing = request(
        url,
        {
          method: init.method,
          headers: { ...init.headers, 'User-Agent': 'shipkeep-control-plane' },
          lookup: this.lookup,
          agent: false,
          maxHeaderSize: 16 * 1024,
          signal: AbortSignal.timeout(this.limits.timeoutMs),
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > this.limits.maxBodyBytes) {
              outgoing.destroy(new RegistryAccessError('registry response too large'));
              return;
            }
            chunks.push(chunk);
          });
          incoming.on('end', () => {
            const headers: Record<string, string | undefined> = {};
            for (const [name, value] of Object.entries(incoming.headers))
              headers[name] = Array.isArray(value) ? value.join(', ') : value;
            resolve({ status: incoming.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
          });
          incoming.on('error', fail);
        },
      );
      outgoing.on('error', fail);
      outgoing.end();
    });
  }
}
