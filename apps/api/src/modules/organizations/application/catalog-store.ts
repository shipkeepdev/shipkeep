import type { OrganizationRecord } from './organization-store';
import type {
  EnvironmentRecord,
  EnvironmentTarget,
  ProjectRecord,
  ProjectTarget,
} from './resource-store';

export interface CatalogBounds {
  readonly cursor?: string;
  readonly limit: number;
}
export interface CatalogPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
export const CATALOG_STORE = Symbol('CatalogStore');
export interface CatalogStore {
  account<T>(userId: string, operation: () => Promise<T>): Promise<T>;
  tenant<T>(organizationId: string, operation: () => Promise<T>): Promise<T>;
  organizations(userId: string, bounds: CatalogBounds): Promise<OrganizationRecord[]>;
  projects(userId: string, organizationId: string, bounds: CatalogBounds): Promise<ProjectRecord[]>;
  environments(
    userId: string,
    target: ProjectTarget,
    bounds: CatalogBounds,
  ): Promise<EnvironmentRecord[]>;
  organization(id: string): Promise<OrganizationRecord | null>;
  project(target: ProjectTarget): Promise<ProjectRecord | null>;
  environment(target: EnvironmentTarget): Promise<EnvironmentRecord | null>;
}
