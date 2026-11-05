import type { Permission, ResourceContext } from '@shipkeep/domain';

export const API_TOKEN_AUTHORITY = Symbol('ApiTokenAuthority');
/** Must query current owner permissions, never trust a token's historical role or scope alone.
 * Role mutations must serialize with identity commands using the affected user's lock.
 */
export interface ApiTokenAuthority {
  allows(
    userId: string,
    permission: Permission,
    target: ResourceContext,
  ): boolean | Promise<boolean>;
}

/** Fail closed for tenant capabilities until the M2.3 live RBAC adapter is installed. */
export class AccountTokenAuthority implements ApiTokenAuthority {
  allows(_userId: string, permission: Permission, target: ResourceContext): boolean {
    return (
      permission === 'profile.read' &&
      target.organizationId === undefined &&
      target.projectId === undefined &&
      target.environmentId === undefined
    );
  }
}
