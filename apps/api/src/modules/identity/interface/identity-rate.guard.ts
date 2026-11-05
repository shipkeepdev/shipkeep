import {
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';

import { IDENTITY_THROTTLE, type IdentityThrottle } from '../application/identity-throttle';
import { normalizeEmail } from '../domain/identity-policy';
import type { IdentityAttempt } from '../domain/throttle-policy';

import { clientIp, type IdentityRequest } from './session-http';
import { enforceThrottle } from './throttle-response';

const ATTEMPT = 'shipkeep:identity:attempt';
export function IdentityAttemptLimit(attempt: IdentityAttempt): CustomDecorator {
  return SetMetadata(ATTEMPT, attempt);
}

@Injectable()
export class IdentityRateGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(IDENTITY_THROTTLE) private readonly throttle: IdentityThrottle,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const attempt = this.reflector.getAllAndOverride<IdentityAttempt | undefined>(ATTEMPT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!attempt) return true;
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    // IdentityGuard already consumed the token/IP API quota before credential validation.
    if (attempt === 'api' && request.identity?.kind === 'api_token') return true;
    const response = context.switchToHttp().getResponse<Response>();
    const decision = await this.throttle.acquire(
      attempt,
      clientIp(request),
      request.identity?.userId ?? subject(request.body),
    );
    enforceThrottle(response, decision);
    return true;
  }
}

function subject(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  if ('email' in body && typeof body.email === 'string' && body.email.length <= 256) {
    try {
      return normalizeEmail(body.email);
    } catch {
      return undefined;
    }
  }
  if ('token' in body && typeof body.token === 'string' && body.token.length <= 256)
    return body.token;
  return undefined;
}
