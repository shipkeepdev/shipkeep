import type { ResourceContext } from './api-token-policy.js';

export const ORGANIZATION_ROLES = ['owner', 'admin', 'member'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];
export const RESOURCE_ROLES = ['admin', 'developer', 'viewer'] as const;
export type ResourceRole = (typeof RESOURCE_ROLES)[number];
export interface ResourceRoleBinding {
  readonly projectId: string;
  readonly environmentId?: string;
  readonly role: string;
}
export interface TenantMembership {
  readonly organizationId: string;
  readonly role: string;
  readonly bindings: readonly ResourceRoleBinding[];
}
export interface TenantResource extends ResourceContext {
  /** Loaded from the environment record, never from caller-supplied authorization metadata. */
  readonly protected?: boolean;
}
const organizationRoles: ReadonlySet<string> = new Set(ORGANIZATION_ROLES);
const resourceRoles: ReadonlySet<string> = new Set(RESOURCE_ROLES);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const protectedActions = new Set(['deploy.run', 'secret.write', 'container.exec']);

/** Pure SPEC 7 decision. The adapter must resolve the resource ancestry and live membership.
 * An allow does not consume a destructive-action confirmation or authorize assigning roles.
 */
export function allowsTenantAction(
  membership: TenantMembership | undefined,
  permission: string,
  target: TenantResource,
): boolean {
  if (
    !membership ||
    !organizationRoles.has(membership.role) ||
    membership.organizationId !== target.organizationId ||
    !validTarget(target) ||
    !validPermissionScope(permission, target) ||
    (protectedActions.has(permission) && typeof target.protected !== 'boolean')
  )
    return false;
  if (membership.role === 'owner') return true;
  if (permission === 'billing.manage' || permission === 'organization.delete') return false;
  if (membership.role === 'admin') return true;
  if (permission === 'organization.read') return true;
  if (['node.manage', 'project.create', 'project.delete'].includes(permission)) return false;
  if (!target.projectId) return false;

  const bindings = membership.bindings.filter((binding) => binding.projectId === target.projectId);
  if (
    bindings.some(
      (binding) =>
        !resourceRoles.has(binding.role) ||
        (binding.environmentId !== undefined && !validId(binding.environmentId)),
    )
  )
    return false;
  const projectBindings = bindings.filter((binding) => binding.environmentId === undefined);
  const environmentBindings = target.environmentId
    ? bindings.filter((binding) => binding.environmentId === target.environmentId)
    : [];
  const effective = environmentBindings.length ? environmentBindings : projectBindings;
  if (projectBindings.length > 1 || effective.length > 1) return false;
  // An environment grant permits parent navigation, never other project-level capabilities.
  if (permission === 'project.read' && bindings.length > 0) return true;
  const role = effective[0]?.role;
  if (!role) return false;
  if (['project.read', 'environment.read', 'observability.read'].includes(permission)) return true;
  if (role === 'admin') return true;
  return role === 'developer' && protectedActions.has(permission) && target.protected === false;
}

/** Run under an organization lock; the caller supplies the current owner count. */
export function canChangeMembership(
  actorRole: string,
  currentRole: string,
  nextRole: string | undefined,
  ownerCount: number,
): boolean {
  if (
    !organizationRoles.has(actorRole) ||
    !organizationRoles.has(currentRole) ||
    (nextRole !== undefined && !organizationRoles.has(nextRole)) ||
    !Number.isSafeInteger(ownerCount) ||
    ownerCount < 1
  )
    return false;
  if (
    actorRole !== 'owner' &&
    (actorRole !== 'admin' || currentRole === 'owner' || nextRole === 'owner')
  )
    return false;
  return currentRole !== 'owner' || nextRole === 'owner' || ownerCount > 1;
}

function validId(value: string): boolean {
  return typeof value === 'string' && UUID.test(value);
}
function validTarget(target: TenantResource): boolean {
  return (
    target.organizationId !== undefined &&
    validId(target.organizationId) &&
    (target.projectId === undefined || validId(target.projectId)) &&
    (target.environmentId === undefined ||
      (target.projectId !== undefined && validId(target.environmentId)))
  );
}
function validPermissionScope(permission: string, target: TenantResource): boolean {
  switch (permission) {
    case 'organization.read':
    case 'organization.delete':
    case 'billing.manage':
    case 'node.manage':
    case 'project.create':
      return target.projectId === undefined;
    case 'project.read':
    case 'project.delete':
    case 'environment.create':
      return target.projectId !== undefined && target.environmentId === undefined;
    case 'environment.read':
    case 'environment.delete':
    case 'deploy.run':
    case 'secret.write':
    case 'container.exec':
    case 'volume.delete':
    case 'database.delete':
      return target.environmentId !== undefined;
    case 'member.manage':
    case 'observability.read':
    case 'audit.read':
      return true;
    default:
      return false;
  }
}
