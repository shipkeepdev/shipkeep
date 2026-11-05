import type { TenantMembership, TenantResource } from '@shipkeep/domain';

import type { TenantScope } from '../modules/identity/interface/route-access';

/** Accounts of the tenant acceptance fixture (`tenant-http.ts`), one per role situation. */
export const tenantActors = [
  'owner',
  'admin',
  'member',
  'projectAdmin',
  'projectDeveloper',
  'projectViewer',
  'environmentAdmin',
  'environmentDeveloper',
  'environmentViewer',
  'restrictedAdmin',
  'outsider',
] as const;
export type TenantActor = (typeof tenantActors)[number];

export interface TenantIds {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

/**
 * The membership each actor holds in the fixture organization. `restrictedAdmin` administers the
 * project but is narrowed to viewer in the environment; `outsider` has no membership.
 */
export function tenantPersona(actor: TenantActor, ids: TenantIds): TenantMembership | undefined {
  if (actor === 'outsider') return undefined;
  const base = { organizationId: ids.organizationId };
  if (actor === 'owner' || actor === 'admin') return { ...base, role: actor, bindings: [] };
  const project = { projectId: ids.projectId };
  const environment = { ...project, environmentId: ids.environmentId };
  const bindings = {
    member: [],
    projectAdmin: [{ ...project, role: 'admin' }],
    projectDeveloper: [{ ...project, role: 'developer' }],
    projectViewer: [{ ...project, role: 'viewer' }],
    environmentAdmin: [{ ...environment, role: 'admin' }],
    environmentDeveloper: [{ ...environment, role: 'developer' }],
    environmentViewer: [{ ...environment, role: 'viewer' }],
    restrictedAdmin: [
      { ...project, role: 'admin' },
      { ...environment, role: 'viewer' },
    ],
  }[actor];
  return { ...base, role: 'member', bindings };
}

/** The resource a route of `scope` designates; fixture environments are protected by default. */
export function tenantTarget(scope: TenantScope, ids: TenantIds): TenantResource {
  if (scope === 'organization') return { organizationId: ids.organizationId };
  if (scope === 'project') return { organizationId: ids.organizationId, projectId: ids.projectId };
  return { ...ids, protected: true };
}
