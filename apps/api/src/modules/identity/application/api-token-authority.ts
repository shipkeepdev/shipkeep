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

/** Account-only part of token authority; tenant permissions require live resource resolution. */
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
