import { resourceReplayRoute } from './resource-replay-route';

const id = '019d0000-0000-7000-8000-000000000001';
const organization = `organizations/${id}`;
const project = `${organization}/projects/${id}`;
const environment = `${project}/environments/${id}`;

describe('resource mutation retry routes', () => {
  it.each([
    'organizations',
    `${organization}/settings`,
    `${organization}/projects`,
    `${project}/settings`,
    `${project}/environments`,
    `${environment}/settings`,
    `${organization}/members`,
    `${organization}/members/${id}/role`,
    `${organization}/members/${id}/remove`,
    `${project}/bindings`,
    `${project}/bindings/${id}/remove`,
    `${environment}/bindings`,
    `${environment}/bindings/${id}/remove`,
  ])('allows the explicit creation/settings route %s', (route) => {
    expect(resourceReplayRoute(route)).toBe(true);
  });
  it.each([
    '',
    'organizations/',
    organization,
    project,
    environment,
    `${organization}/delete`,
    `${project}/delete`,
    `${environment}/delete`,
    `${organization}/members/${id}`,
    `${organization}/members/${id}/delete`,
    `${organization}/members/invalid/role`,
    `${organization}/members/${id.toUpperCase()}/remove`,
    `${organization}/members/${id}/role/extra`,
    `${organization}/members/${id}/remove/extra`,
    `${organization}/bindings`,
    `${project}/bindings/${id}`,
    `${project}/bindings/${id}/role`,
    `${project}/bindings/invalid/remove`,
    `${environment}/bindings/${id}/delete`,
    `${environment}/environments`,
    `${environment}/bindings/${id.toUpperCase()}/remove`,
    `${project}/members`,
    `${organization}/settings?token=private`,
    `${organization}/settings/`,
    `organizations/${id.toUpperCase()}/settings`,
    `organizations/${id}\n/settings`,
    `organizations/${id}/projects/invalid/settings`,
    `organizations/invalid/projects/${id}/settings`,
    `${project}/environments/invalid/settings`,
    `${project}/other/${id}/settings`,
    `${organization}/other/${id}/settings`,
    `${environment}/settings/extra`,
    '/organizations',
    'organizations/../../auth/login',
  ])('rejects unrelated or malformed routes %s', (route) => {
    expect(resourceReplayRoute(route)).toBe(false);
  });
});
