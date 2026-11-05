import { InvalidInputError } from './errors.js';

/** Closed authorization vocabulary shared by token scopes and the SPEC 7 policy matrix. */
export const PERMISSIONS = [
  'profile.read',
  'organization.read',
  'organization.update',
  'organization.delete',
  'billing.manage',
  'member.manage',
  'node.manage',
  'project.read',
  'project.create',
  'project.update',
  'project.delete',
  'environment.read',
  'environment.create',
  'environment.update',
  'environment.delete',
  'deploy.run',
  'secret.write',
  'container.exec',
  'volume.delete',
  'database.delete',
  'observability.read',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export interface ResourceContext {
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly environmentId?: string;
}
export interface ApiScope extends ResourceContext {
  readonly permission: Permission;
}
export const API_TOKEN_MAX_AGE_MS = 90 * 86400000;
export const API_TOKEN_MAX_ACTIVE = 50;
const permissionSet: ReadonlySet<string> = new Set(PERMISSIONS);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const scopeKeys = new Set(['permission', 'organizationId', 'projectId', 'environmentId']);

export function parseApiScopes(value: unknown): readonly ApiScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw invalidScopes();
  const unique = new Map<string, ApiScope>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalidScopes();
    const input = entry as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => !scopeKeys.has(key)) ||
      typeof input['permission'] !== 'string' ||
      !permissionSet.has(input['permission'])
    )
      throw invalidScopes();
    const permission = input['permission'] as Permission;
    const organizationId = resourceId(input['organizationId']);
    const projectId = resourceId(input['projectId']);
    const environmentId = resourceId(input['environmentId']);
    const scope: ApiScope = Object.freeze({
      permission,
      ...(organizationId ? { organizationId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(environmentId ? { environmentId } : {}),
    });
    if (
      !validContext(scope) ||
      (permission === 'profile.read' ? organizationId !== undefined : organizationId === undefined)
    )
      throw invalidScopes();
    unique.set(JSON.stringify(scope), scope);
  }
  const scopes = [...unique.values()];
  if (
    new Set(scopes.flatMap((scope) => (scope.organizationId ? [scope.organizationId] : []))).size >
    1
  )
    throw invalidScopes();
  return Object.freeze(scopes);
}

/** This only narrows a permission; the owner's live RBAC decision must ALSO allow the request. */
export function scopeCovers(
  scope: ApiScope,
  permission: Permission,
  target: ResourceContext,
): boolean {
  if (
    !permissionSet.has(permission) ||
    scope.permission !== permission ||
    !validContext(scope) ||
    !validContext(target)
  )
    return false;
  if (permission === 'profile.read')
    return scope.organizationId === undefined && target.organizationId === undefined;
  return (
    scope.organizationId !== undefined &&
    scope.organizationId === target.organizationId &&
    (scope.projectId === undefined || scope.projectId === target.projectId) &&
    (scope.environmentId === undefined || scope.environmentId === target.environmentId)
  );
}

export function assertApiTokenName(input: string): string {
  const name = input.trim();
  if (!name || Array.from(name).length > 64 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input))
    throw new InvalidInputError(
      'invalid_api_token_name',
      'Token names must contain 1 to 64 characters without control characters.',
    );
  return name;
}

export function assertApiTokenExpiry(expiresAt: Date, now: Date): void {
  const lifetime = expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(lifetime) || lifetime < 60000 || lifetime > API_TOKEN_MAX_AGE_MS)
    throw new InvalidInputError(
      'invalid_api_token_expiry',
      'API tokens must expire between one minute and ninety days from creation.',
    );
}

function resourceId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) throw invalidScopes();
  return value;
}
function validContext(value: ResourceContext): boolean {
  return (
    [value.organizationId, value.projectId, value.environmentId].every(
      (id) => id === undefined || (typeof id === 'string' && id.length === 36 && UUID.test(id)),
    ) &&
    (value.projectId === undefined || value.organizationId !== undefined) &&
    (value.environmentId === undefined || value.projectId !== undefined)
  );
}
function invalidScopes(): InvalidInputError {
  return new InvalidInputError(
    'invalid_api_token_scopes',
    'Supply 1 to 32 explicit permissions with a valid organization/project/environment hierarchy.',
  );
}
