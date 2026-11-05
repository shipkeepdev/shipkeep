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
  { path: '', pathMatch: 'full', redirectTo: 'auth/login' },
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
  { path: '**', redirectTo: 'auth/login' },
];
