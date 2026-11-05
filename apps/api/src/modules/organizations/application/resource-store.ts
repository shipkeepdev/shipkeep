import type { EnvironmentSettings, ProjectSettings } from '@shipkeep/domain';

export interface ProjectTarget {
  readonly organizationId: string;
  readonly projectId: string;
}
export interface EnvironmentTarget extends ProjectTarget {
  readonly environmentId: string;
}
export interface ProjectRecord extends ProjectSettings {
  readonly id: string;
  readonly organizationId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface EnvironmentRecord extends EnvironmentSettings {
  readonly id: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export const RESOURCE_STORE = Symbol('ResourceStore');
export interface ResourceStore {
  transaction<T>(organizationId: string, operation: () => Promise<T>): Promise<T>;
  createProject(record: ProjectRecord): Promise<ProjectRecord>;
  updateProject(
    target: ProjectTarget,
    settings: ProjectSettings,
    now: Date,
  ): Promise<ProjectRecord>;
  createEnvironment(record: EnvironmentRecord): Promise<EnvironmentRecord>;
  updateEnvironment(
    target: EnvironmentTarget,
    settings: EnvironmentSettings,
    now: Date,
  ): Promise<EnvironmentRecord>;
}
