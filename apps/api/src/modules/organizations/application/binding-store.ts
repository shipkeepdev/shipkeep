import type { ResourceRole } from '@shipkeep/domain';

import type { ProjectTarget } from './resource-store';

export interface BindingTarget extends ProjectTarget {
  readonly environmentId?: string;
}
export interface BindingRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string | null;
  readonly membershipId: string;
  readonly role: ResourceRole;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export const BINDING_STORE = Symbol('BindingStore');
export interface BindingStore {
  find(target: BindingTarget, membershipId: string): Promise<BindingRecord | null>;
  save(record: BindingRecord): Promise<void>;
  remove(target: BindingTarget, id: string): Promise<void>;
}
