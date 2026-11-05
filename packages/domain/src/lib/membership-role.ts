import { InvalidInputError } from './errors.js';
import {
  ORGANIZATION_ROLES,
  RESOURCE_ROLES,
  type OrganizationRole,
  type ResourceRole,
} from './organization-policy.js';

export function parseOrganizationRole(value: unknown): OrganizationRole {
  const role = ORGANIZATION_ROLES.find((candidate) => candidate === value);
  if (!role)
    throw new InvalidInputError('invalid_organization_role', 'Choose owner, admin or member.');
  return role;
}
export function parseResourceRole(value: unknown): ResourceRole {
  const role = RESOURCE_ROLES.find((candidate) => candidate === value);
  if (!role)
    throw new InvalidInputError('invalid_resource_role', 'Choose admin, developer or viewer.');
  return role;
}
