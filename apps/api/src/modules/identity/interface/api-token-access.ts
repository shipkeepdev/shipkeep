import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import type { Permission } from '@shipkeep/domain';

export const API_TOKEN_ACCESS = 'shipkeep:identity:api-token-access';
/** Opt-in for account-level access. Tenant routes also need resource resolution in M2.3. */
export function AllowApiToken(permission: Permission): CustomDecorator {
  return SetMetadata(API_TOKEN_ACCESS, permission);
}
