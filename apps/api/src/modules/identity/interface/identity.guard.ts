import {
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppConfig } from '../../../platform/config/app-config';
import { SessionCommands } from '../application/session-commands';
import { AuthenticationError } from '../domain/identity-policy';

import {
  assertOrigin,
  cookiePolicy,
  headerCredential,
  type IdentityRequest,
  readCredential,
} from './session-http';

const ANONYMOUS = 'shipkeep:identity:anonymous';
export function AllowAnonymous(): CustomDecorator {
  return SetMetadata(ANONYMOUS, true);
}
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Every controller requires authentication unless explicitly marked anonymous. */
@Injectable()
export class IdentityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfig,
    private readonly sessions: SessionCommands,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    const unsafe = !SAFE_METHODS.has(request.method);
    if (unsafe) assertOrigin(request, this.config.get('API_PUBLIC_URL'));
    if (
      this.reflector.getAllAndOverride<boolean>(ANONYMOUS, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    // API-token authentication is introduced separately; never fall back from an invalid bearer
    // credential to an ambient browser session.
    if (request.headers.authorization !== undefined) throw new AuthenticationError();
    const policy = cookiePolicy(this.config.get('API_PUBLIC_URL'));
    const token = readCredential(request.headers.cookie, policy.name);
    const csrf = unsafe ? headerCredential(request.headers['x-shipkeep-csrf']) : undefined;
    const { user, session } = await this.sessions.authenticate(token, csrf);
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
}
