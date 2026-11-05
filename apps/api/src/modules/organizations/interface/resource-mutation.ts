import { applyDecorators, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiHeader } from '@nestjs/swagger';
import type { Permission } from '@shipkeep/domain';

import { AllowApiToken } from '../../identity/interface/api-token-access';
import { IdentityAttemptLimit } from '../../identity/interface/identity-rate.guard';
import { RequireTenant, type TenantScope } from '../../identity/interface/route-access';

function headers(sessionOnly: boolean): MethodDecorator {
  return applyDecorators(
    ApiCookieAuth('session'),
    ApiHeader({
      name: 'Origin',
      required: sessionOnly,
      description: 'Exact API origin; required for session mutations.',
    }),
    ApiHeader({
      name: 'X-Shipkeep-CSRF',
      required: sessionOnly,
      description: 'Session-bound CSRF proof; required for session mutations.',
    }),
    ApiHeader({
      name: 'Idempotency-Key',
      required: false,
      description:
        'Lowercase UUIDv4/v7. Encrypted result retained for five minutes and bound to the credential.',
    }),
  );
}

export function BrowserMutation(path: string, status = 200): MethodDecorator {
  return applyDecorators(
    Post(path),
    HttpCode(status),
    IdentityAttemptLimit('token'),
    headers(true),
  );
}

export function ResourceMutation(
  path: string,
  permission: Exclude<Permission, 'profile.read'>,
  scope: TenantScope,
  status = 200,
): MethodDecorator {
  return applyDecorators(
    Post(path),
    HttpCode(status),
    RequireTenant(permission, scope),
    AllowApiToken(permission),
    IdentityAttemptLimit('api'),
    ApiBearerAuth('apiToken'),
    headers(false),
  );
}
