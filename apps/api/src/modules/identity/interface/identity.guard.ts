import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Permission, type ResourceContext, Secret } from '@shipkeep/domain';
import type { Response } from 'express';

import { AppConfig } from '../../../platform/config/app-config';
import { ANONYMOUS } from '../../../platform/http/allow-anonymous';
import { TenantAccess } from '../../organizations/application/tenant-access';
import { ApiTokenAuthentication } from '../application/api-token-authentication';
import { IDENTITY_THROTTLE, type IdentityThrottle } from '../application/identity-throttle';
import { SessionCommands } from '../application/session-commands';
import { AuthenticationError } from '../domain/identity-policy';

import {
  assertOrigin,
  cookiePolicy,
  headerCredential,
  type IdentityRequest,
  readCredential,
  clientIp,
} from './session-http';
import { API_TOKEN_ACCESS } from './api-token-access';
import { enforceThrottle } from './throttle-response';
import { ROUTE_ACCESS, type RouteAccess, routeTarget } from './route-access';

export { AllowAnonymous } from '../../../platform/http/allow-anonymous';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Undeclared routes deny access, including otherwise valid credentials. */
@Injectable()
export class IdentityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfig,
    private readonly sessions: SessionCommands,
    private readonly tokens: ApiTokenAuthentication,
    private readonly tenants: TenantAccess,
    @Inject(IDENTITY_THROTTLE) private readonly throttle: IdentityThrottle,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    const unsafe = !SAFE_METHODS.has(request.method);
    if (
      this.reflector.getAllAndOverride<boolean>(ANONYMOUS, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      if (unsafe) assertOrigin(request, this.config.get('API_PUBLIC_URL'));
      return true;
    }
    const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(ROUTE_ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!access) throw new AuthenticationError();
    const target = routeTarget(access, request.params);
    if (request.headers.authorization !== undefined)
      return this.bearer(context, request, access, target);
    if (unsafe) assertOrigin(request, this.config.get('API_PUBLIC_URL'));
    const policy = cookiePolicy(this.config.get('API_PUBLIC_URL'));
    const token = readCredential(request.headers.cookie, policy.name);
    const csrf = unsafe ? headerCredential(request.headers['x-shipkeep-csrf']) : undefined;
    const { user, session } = await this.sessions.authenticate(token, csrf);
    if (access.kind === 'tenant') await this.tenants.require(user.id, access.permission, target);
    request.identity = {
      kind: 'session',
      userId: user.id,
      email: user.email,
      sessionId: session.id,
      securityVersion: user.securityVersion,
      expiresAt: session.expiresAt,
      token,
    };
    return true;
  }

  private async bearer(
    context: ExecutionContext,
    request: IdentityRequest,
    access: RouteAccess,
    target: ResourceContext,
  ): Promise<boolean> {
    const values = request.rawHeaders.filter(
      (value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization',
    );
    const match =
      values.length === 1
        ? /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? '')
        : null;
    const value = match?.at(1);
    enforceThrottle(
      context.switchToHttp().getResponse<Response>(),
      await this.throttle.acquire('api', clientIp(request), value),
    );
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(API_TOKEN_ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
    const expected = access.kind === 'tenant' ? access.permission : 'profile.read';
    if (!value || permission !== expected) throw new AuthenticationError();
    const { user, token } = await this.tokens.authenticate(new Secret(value), permission, target);
    request.identity = {
      kind: 'api_token',
      userId: user.id,
      email: user.email,
      tokenId: token.id,
      securityVersion: user.securityVersion,
      expiresAt: token.expiresAt,
    };
    return true;
  }
}
