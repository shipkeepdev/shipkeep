import { AuthenticationError } from '../domain/identity-policy';

import { type RouteAccess, routeTarget } from './route-access';

const organizationId = '019d0000-0000-7000-8000-000000000001';
const projectId = '019d0000-0000-7000-8000-000000000002';
const environmentId = '019d0000-0000-7000-8000-000000000003';
const account: RouteAccess = { kind: 'account' };
const organization: RouteAccess = {
  kind: 'tenant',
  scope: 'organization',
  permission: 'organization.read',
};
const project: RouteAccess = { kind: 'tenant', scope: 'project', permission: 'project.read' };
const environment: RouteAccess = {
  kind: 'tenant',
  scope: 'environment',
  permission: 'environment.read',
};

describe('explicit HTTP resource targets', () => {
  it.each([
    [account, { id: projectId }, {}],
    [organization, { organizationId }, { organizationId }],
    [project, { organizationId, projectId }, { organizationId, projectId }],
    [
      environment,
      { organizationId, projectId, environmentId, role: 'owner' },
      { organizationId, projectId, environmentId },
    ],
  ] satisfies [RouteAccess, Record<string, unknown>, Record<string, unknown>][])(
    'resolves only the declared path scope %#',
    (access, params, expected) => {
      expect(routeTarget(access, params)).toEqual(expected);
    },
  );

  it.each(['organizationId', 'projectId', 'environmentId'])(
    'rejects account access with %s',
    (key) => {
      expect(() => routeTarget(account, { [key]: organizationId })).toThrow(AuthenticationError);
    },
  );

  it.each([
    [organization, {}],
    [organization, { organizationId, projectId }],
    [organization, { organizationId, environmentId }],
    [project, { organizationId }],
    [project, { organizationId, projectId, environmentId }],
    [environment, { organizationId, environmentId }],
    [environment, { organizationId, projectId }],
    [environment, { organizationId: `${organizationId}\n`, projectId, environmentId }],
    [environment, { organizationId: [organizationId], projectId, environmentId }],
    [environment, { organizationId, projectId: 'not-a-uuid', environmentId }],
    [environment, { organizationId, projectId, environmentId: organizationId.toUpperCase() }],
  ] satisfies [RouteAccess, Record<string, unknown>][])(
    'rejects missing, malformed or surplus ancestry %#',
    (access, params) => {
      expect(() => routeTarget(access, params)).toThrow(
        expect.objectContaining({ code: 'resource_not_found' }),
      );
    },
  );
});
