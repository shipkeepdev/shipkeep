import { type Route } from '@angular/router';

import { type PreviewView } from './dashboard/preview-screens';
import { AUTH_MODES } from './identity/auth-form-store';

const titles = {
  login: 'Sign in',
  register: 'Create account',
  'verify-email': 'Verify email',
  'request-verification': 'Send verification email',
  'forgot-password': 'Reset password',
  'reset-password': 'Choose a new password',
  mfa: 'Two-factor authentication',
  recovery: 'Recovery code',
};

const preview = (
  path: string,
  view: PreviewView,
  title: string,
  crumbs: readonly string[],
): Route => ({
  path,
  title: `${title} · Shipkeep`,
  data: { view, crumbs },
  loadComponent: () => import('./dashboard/preview-page').then((module) => module.PreviewPage),
});

const ENVIRONMENT = 'projects/:projectId/environments/:environmentId';

/** Pages inside an organization, in the dashboard frame. Paths follow `dashboard/views.ts`. */
const dashboard: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Overview · Shipkeep',
    data: { crumbs: ['Overview'] },
    loadComponent: () => import('./dashboard/overview-page').then((module) => module.OverviewPage),
  },
  {
    path: 'applications',
    title: 'Applications · Shipkeep',
    data: { crumbs: ['Applications'] },
    loadComponent: () =>
      import('./dashboard/applications-page').then((module) => module.ApplicationsPage),
  },
  {
    path: 'new',
    title: 'New resource · Shipkeep',
    data: { crumbs: ['New resource'] },
    loadComponent: () =>
      import('./dashboard/new-resource-page').then((module) => module.NewResourcePage),
  },
  {
    path: 'previews',
    title: 'Previews · Shipkeep',
    data: { crumbs: ['Previews'] },
    loadComponent: () => import('./dashboard/previews-page').then((module) => module.PreviewsPage),
  },
  { path: 'nodes', pathMatch: 'full', redirectTo: 'servers' },
  {
    path: 'servers',
    title: 'Servers · Shipkeep',
    data: { crumbs: ['Servers'] },
    loadComponent: () => import('./fleet/servers-page').then((module) => module.ServersPage),
  },
  preview('servers/sample', 'server', 'Server', ['Servers', 'srv-par-1']),
  {
    path: 'databases',
    title: 'Databases · Shipkeep',
    data: { crumbs: ['Databases'] },
    loadComponent: () =>
      import('./dashboard/databases-page').then((module) => module.DatabasesPage),
  },
  preview('databases/sample', 'db', 'Database', ['Client Lumen', 'production', 'pg-factures']),
  preview('services/sample', 'service', 'Service', ['Internal tools', 'production', 'grafana']),
  preview('deployments/sample', 'deploy', 'Deployment', [
    'Client Lumen',
    'production',
    'api-facturation',
    '4f2c1a9',
  ]),
  {
    path: 'observability',
    title: 'Observability · Shipkeep',
    data: { crumbs: ['Observability'] },
    loadComponent: () =>
      import('./dashboard/observability-page').then((module) => module.ObservabilityPage),
  },
  {
    path: 'audit',
    title: 'Audit log · Shipkeep',
    data: { crumbs: ['Audit log'] },
    loadComponent: () => import('./audit/audit-page').then((module) => module.AuditPage),
  },
  {
    path: 'members',
    title: 'Members & access · Shipkeep',
    data: { crumbs: ['Members & access'] },
    loadComponent: () => import('./access/members-page').then((module) => module.MembersPage),
  },
  preview('integrations', 'integrations', 'Integrations', ['Integrations']),
  preview('shared-variables', 'sharedvars', 'Shared variables', ['Shared variables']),
  preview('terminal', 'terminal', 'Terminal', ['Terminal']),
  preview('vulnerabilities', 'vulns', 'Vulnerabilities', ['Vulnerabilities']),
  {
    path: 'projects',
    title: 'Projects · Shipkeep',
    data: { crumbs: ['Projects'] },
    loadComponent: () => import('./dashboard/projects-page').then((module) => module.ProjectsPage),
  },
  {
    path: 'projects/:projectId',
    title: 'Project · Shipkeep',
    data: { crumbs: ['Projects'] },
    loadComponent: () => import('./workspace/project-page').then((module) => module.ProjectPage),
  },
  {
    path: ENVIRONMENT,
    title: 'Environment · Shipkeep',
    data: { crumbs: ['Projects'] },
    loadComponent: () =>
      import('./workspace/environment-page').then((module) => module.EnvironmentPage),
  },
  {
    path: `${ENVIRONMENT}/applications/:applicationId`,
    title: 'Application · Shipkeep',
    data: { crumbs: ['Applications'] },
    loadComponent: () =>
      import('./delivery/application-page').then((module) => module.ApplicationPage),
  },
  {
    path: 'organization',
    title: 'Organization · Shipkeep',
    data: { crumbs: ['Organization'] },
    loadComponent: () =>
      import('./workspace/organization-page').then((module) => module.OrganizationPage),
  },
  preview('notifications', 'notifs', 'Notifications', ['Notifications']),
  preview('tags', 'tags', 'Tags', ['Tags']),
  preview('settings', 'settings', 'Settings', ['Settings']),
  preview('onboarding', 'onboarding', 'First start', ['First start']),
  {
    path: 'profile',
    title: 'Profile · Shipkeep',
    data: { crumbs: ['Profile'] },
    loadComponent: () => import('./identity/account-page').then((module) => module.AccountPage),
  },
];

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'home' },
  {
    path: 'home',
    title: 'Shipkeep',
    loadComponent: () => import('./workspace/landing-page').then((module) => module.LandingPage),
  },
  // Existing email messages use these public paths; codes are entered in the form only.
  { path: 'verify-email', pathMatch: 'full', redirectTo: 'auth/verify-email' },
  { path: 'reset-password', pathMatch: 'full', redirectTo: 'auth/reset-password' },
  ...[...AUTH_MODES, 'mfa' as const, 'recovery' as const].map((mode): Route => ({
    path: `auth/${mode}`,
    data: { mode },
    title: `${titles[mode]} · Shipkeep`,
    loadComponent: () => import('./identity/auth-page').then((module) => module.AuthPage),
  })),
  { path: 'account/security', pathMatch: 'full', redirectTo: 'account?section=security' },
  {
    // Pages of the account, outside any organization.
    path: '',
    loadComponent: () => import('./shell/public-frame').then((module) => module.PublicFrame),
    children: [
      {
        path: 'orgs',
        pathMatch: 'full',
        title: 'Organizations · Shipkeep',
        loadComponent: () =>
          import('./workspace/organizations-page').then((module) => module.OrganizationsPage),
      },
      {
        path: 'account',
        pathMatch: 'full',
        title: 'Account · Shipkeep',
        loadComponent: () => import('./identity/account-page').then((module) => module.AccountPage),
      },
    ],
  },
  {
    path: 'orgs/:organizationId',
    loadComponent: () =>
      import('./dashboard/dashboard-layout').then((module) => module.DashboardLayout),
    children: dashboard,
  },
  { path: '**', redirectTo: 'auth/login' },
];
