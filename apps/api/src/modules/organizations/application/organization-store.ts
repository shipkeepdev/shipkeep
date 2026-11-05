import type { OrganizationSettings } from '@shipkeep/domain';

export const ORGANIZATION_STORE = Symbol('OrganizationStore');
export interface OrganizationRecord extends OrganizationSettings {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface OrganizationStore {
  transaction<T>(organizationId: string, operation: () => Promise<T>): Promise<T>;
  create(record: OrganizationRecord, ownerId: string): Promise<void>;
  update(id: string, settings: OrganizationSettings, now: Date): Promise<OrganizationRecord>;
}
