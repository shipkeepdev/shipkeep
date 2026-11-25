import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

import { ForbiddenException } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';
import type { Request, Response } from 'express';

import type { SessionGrant } from '../application/session-commands';
import type { ResourceSecurityContext } from '../application/resource-security-context';
import { AuthenticationError, TOKEN_PATTERN } from '../domain/identity-policy';

export interface CookiePolicy {
  readonly name: string;
  readonly csrfName: string;
  readonly secure: boolean;
}
export interface SessionPrincipal {
  readonly kind: 'session';
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly sessionId: string;
  readonly securityVersion: number;
  readonly expiresAt: Date;
  readonly token: Secret;
}
export interface ApiTokenPrincipal {
  readonly kind: 'api_token';
  readonly displayName: string | null;
  readonly userId: string;
  readonly email: string;
  readonly tokenId: string;
  readonly securityVersion: number;
  readonly expiresAt: Date;
  readonly token: Secret;
}
export type IdentityPrincipal = SessionPrincipal | ApiTokenPrincipal;
export type IdentityRequest = Request<Record<string, string>, unknown, unknown> & {
  identity?: IdentityPrincipal;
};

export function cookiePolicy(publicUrl: string): CookiePolicy {
  const secure = new URL(publicUrl).protocol === 'https:';
  const prefix = secure ? '__Host-' : '';
  return { name: `${prefix}shipkeep_session`, csrfName: `${prefix}shipkeep_csrf`, secure };
}

export function readCredential(header: string | undefined, name: string): Secret {
  const values = (header ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${name}=`));
  if (values.length !== 1) throw new AuthenticationError();
  return headerCredential(values[0].slice(name.length + 1));
}

export function headerCredential(value: string | string[] | undefined): Secret {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) throw new AuthenticationError();
  return new Secret(value);
}

export function assertOrigin(request: Pick<Request, 'headers'>, publicUrl: string): void {
  if (
    request.headers.origin !== new URL(publicUrl).origin ||
    request.headers['sec-fetch-site'] === 'cross-site'
  ) {
    throw new ForbiddenException('Request origin is not allowed.');
  }
}

export function setSessionCookies(
  response: Response,
  grant: SessionGrant,
  policy: CookiePolicy,
): void {
  const options = {
    secure: policy.secure,
    sameSite: 'strict' as const,
    path: '/',
    expires: grant.expiresAt,
  };
  response.cookie(policy.name, grant.token.expose(), { ...options, httpOnly: true });
  response.cookie(policy.csrfName, grant.csrf.expose(), { ...options, httpOnly: false });
}

export function clearSessionCookies(response: Response, policy: CookiePolicy): void {
  const options = { secure: policy.secure, sameSite: 'strict' as const, path: '/' };
  response.clearCookie(policy.name, { ...options, httpOnly: true });
  response.clearCookie(policy.csrfName, { ...options, httpOnly: false });
}

export function clientIp(request: Request): string {
  const ip = request.ip;
  if (ip && isIP(ip)) return ip;
  return request.socket.remoteAddress ?? 'unknown';
}

/**
 * The client's address on a request Express does not see, a WebSocket upgrade, resolved as Express
 * resolves `req.ip` with `trust proxy`: from the socket's peer leftwards through `X-Forwarded-For`
 * while the address in hand is a trusted proxy (`TRUST_PROXY`: none, loopback or one address).
 */
export function upgradeClientIp(
  request: Pick<IncomingMessage, 'headers' | 'socket'>,
  trust: string,
): string {
  const header = request.headers['x-forwarded-for'];
  const forwarded = (typeof header === 'string' ? header : '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  let address = request.socket.remoteAddress ?? '';
  for (let index = forwarded.length - 1; index >= 0 && trustedProxy(address, trust); index--) {
    const next = forwarded[index] ?? '';
    if (isIP(next) === 0) break;
    address = next;
  }
  return address === '' ? 'unknown' : address;
}

function trustedProxy(address: string, trust: string): boolean {
  const plain = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (trust === 'none' || plain === '') return false;
  if (trust === 'loopback') return plain === '::1' || /^127\./.test(plain);
  return plain === trust;
}

export function principal(request: IdentityRequest): SessionPrincipal {
  if (request.identity?.kind !== 'session') throw new AuthenticationError();
  return request.identity;
}

export function authenticatedPrincipal(request: IdentityRequest): IdentityPrincipal {
  if (!request.identity) throw new AuthenticationError();
  return request.identity;
}

/** Preserve the authenticated credential for the command's transactional revalidation. */
export function resourceContext(request: IdentityRequest): ResourceSecurityContext {
  const actor = authenticatedPrincipal(request);
  return {
    userId: actor.userId,
    securityVersion: actor.securityVersion,
    ip: clientIp(request),
    userAgent: request.headers['user-agent'] ?? '',
    ...(actor.kind === 'api_token'
      ? { apiCredential: { id: actor.tokenId, value: actor.token } }
      : { session: { token: actor.token } }),
  };
}
