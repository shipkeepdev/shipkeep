import type { ResourceRole } from '@shipkeep/domain';

import type { BindingTarget } from './binding-store';
import type { CatalogBounds } from './catalog-store';
import type { MembershipRecord } from './membership-store';

export interface MemberView extends MembershipRecord {
  readonly email: string;
  /** The name the account shows instead of its address, when it set one (issue #251). */
  readonly displayName: string | null;
  readonly active: boolean;
}
export interface BindingView extends MemberView {
  readonly role: ResourceRole;
  readonly source: 'organization' | 'project' | 'environment';
  readonly directRole: ResourceRole | null;
  readonly inheritedRole: ResourceRole | null;
}
export const ADMINISTRATION_STORE = Symbol('AdministrationStore');
export interface AdministrationStore {
  transaction<T>(organizationId: string, operation: () => Promise<T>): Promise<T>;
  members(organizationId: string, bounds: CatalogBounds): Promise<MemberView[]>;
  bindings(target: BindingTarget, bounds: CatalogBounds): Promise<BindingView[]>;
}
