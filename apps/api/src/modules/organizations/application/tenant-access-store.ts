import type { ResourceContext, TenantMembership, TenantResource } from '@shipkeep/domain';

export const TENANT_ACCESS_STORE = Symbol('TenantAccessStore');
export interface TenantAccessRecord {
  readonly membership: TenantMembership;
  readonly resource: TenantResource;
}
/** Scoped reads participate in the caller's transaction, including identity mutation locks. */
export interface TenantAccessStore {
  transaction<T>(organizationId: string, operation: () => Promise<T>): Promise<T>;
  resolve(
    userId: string,
    organizationId: string,
    target: ResourceContext,
  ): Promise<TenantAccessRecord | undefined>;
}
