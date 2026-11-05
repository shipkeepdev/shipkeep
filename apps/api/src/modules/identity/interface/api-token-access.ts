import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import type { Permission } from '@shipkeep/domain';

export const API_TOKEN_ACCESS = 'shipkeep:identity:api-token-access';
/** Explicit bearer opt-in; must match the route's declared account/tenant permission. */
export function AllowApiToken(permission: Permission): CustomDecorator {
  return SetMetadata(API_TOKEN_ACCESS, permission);
}
