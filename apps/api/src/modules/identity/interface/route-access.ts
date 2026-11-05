import { type CustomDecorator, SetMetadata } from '@nestjs/common';
import { isTenantId, NotFoundError, type Permission, type ResourceContext } from '@shipkeep/domain';

import { AuthenticationError } from '../domain/identity-policy';

export const ROUTE_ACCESS = 'shipkeep:identity:route-access';
export type TenantScope = 'organization' | 'project' | 'environment';
export type RouteAccess =
  | { readonly kind: 'account' }
  | {
      readonly kind: 'tenant';
      readonly permission: Exclude<Permission, 'profile.read'>;
      readonly scope: TenantScope;
    };

/** Authenticated account operations without a tenant resource in the route. */
export function AllowAccount(): CustomDecorator {
  return SetMetadata(ROUTE_ACCESS, { kind: 'account' } satisfies RouteAccess);
}

export function RequireTenant(
  permission: Exclude<Permission, 'profile.read'>,
  scope: TenantScope,
): CustomDecorator {
  return SetMetadata(ROUTE_ACCESS, { kind: 'tenant', permission, scope } satisfies RouteAccess);
}

/** Resolve only canonical path parameters; body/query authorization hints are never trusted. */
export function routeTarget(
  access: RouteAccess,
  params: Readonly<Record<string, unknown>>,
): ResourceContext {
  const { organizationId, projectId, environmentId } = params;
  if (access.kind === 'account') {
    if ([organizationId, projectId, environmentId].some((id) => id !== undefined))
      throw new AuthenticationError();
    return {};
  }
  const project = access.scope === 'project' || access.scope === 'environment';
  const environment = access.scope === 'environment';
  if (
    !isTenantId(organizationId) ||
    (project ? !isTenantId(projectId) : projectId !== undefined) ||
    (environment ? !isTenantId(environmentId) : environmentId !== undefined)
  )
    throw new NotFoundError('resource');
  return {
    organizationId,
    ...(project ? { projectId: projectId as string } : {}),
    ...(environment ? { environmentId: environmentId as string } : {}),
  };
}
