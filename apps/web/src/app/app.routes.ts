import { type Route } from '@angular/router';

import { AUTH_MODES } from './identity/auth-form-store';

const titles = {
  login: 'Sign in',
  register: 'Create account',
  'verify-email': 'Verify email',
  'request-verification': 'Send verification email',
  'forgot-password': 'Reset password',
  'reset-password': 'Choose a new password',
};
export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'orgs' },
  // Existing email messages use these public paths; codes are entered in the form only.
  { path: 'verify-email', pathMatch: 'full', redirectTo: 'auth/verify-email' },
  { path: 'reset-password', pathMatch: 'full', redirectTo: 'auth/reset-password' },
  ...AUTH_MODES.map((mode): Route => ({
    path: `auth/${mode}`,
    data: { mode },
    title: `${titles[mode]} · Shipkeep`,
    loadComponent: () => import('./identity/auth-page').then((module) => module.AuthPage),
  })),
  {
    path: 'account/security',
    title: 'Account security · Shipkeep',
    loadComponent: () => import('./identity/account-page').then((module) => module.AccountPage),
  },
  {
    path: 'orgs',
    title: 'Organizations · Shipkeep',
    loadComponent: () =>
      import('./workspace/organizations-page').then((module) => module.OrganizationsPage),
  },
  {
    path: 'orgs/:organizationId',
    title: 'Organization · Shipkeep',
    loadComponent: () =>
      import('./workspace/organization-page').then((module) => module.OrganizationPage),
  },
  {
    path: 'orgs/:organizationId/projects/:projectId',
    title: 'Project · Shipkeep',
    loadComponent: () => import('./workspace/project-page').then((module) => module.ProjectPage),
  },
  {
    path: 'orgs/:organizationId/projects/:projectId/environments/:environmentId',
    title: 'Environment · Shipkeep',
    loadComponent: () =>
      import('./workspace/environment-page').then((module) => module.EnvironmentPage),
  },
  {
    path: 'orgs/:organizationId/projects/:projectId/environments/:environmentId/applications/:applicationId',
    title: 'Application · Shipkeep',
    loadComponent: () =>
      import('./delivery/application-page').then((module) => module.ApplicationPage),
  },
  { path: '**', redirectTo: 'auth/login' },
];
