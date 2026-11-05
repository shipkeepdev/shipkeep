import type { OrganizationRole } from '@shipkeep/domain';

export interface MembershipRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly orgRole: OrganizationRole;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export const MEMBERSHIP_STORE = Symbol('MembershipStore');
export interface MembershipCandidate extends MembershipRecord {
  readonly email: string;
}
export interface MembershipStore {
  transaction<T>(organizationId: string, operation: () => Promise<T>): Promise<T>;
  lockOrganization(organizationId: string): Promise<void>;
  find(organizationId: string, id: string): Promise<MembershipRecord | null>;
  forUser(organizationId: string, userId: string): Promise<MembershipRecord | null>;
  forEmail(organizationId: string, email: string): Promise<MembershipCandidate | null>;
  ownerCount(organizationId: string): Promise<number>;
  insert(record: MembershipRecord): Promise<void>;
  setRole(
    organizationId: string,
    id: string,
    role: OrganizationRole,
    now: Date,
  ): Promise<MembershipRecord>;
  remove(organizationId: string, id: string): Promise<void>;
}
