import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ModulesContainer, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import { AppModule } from './app.module';
import { routeInventory } from './testing/route-inventory';

/**
 * PLAN M2.4c (CLAUDE.md rule 6): every state-changing route declares the audit events its
 * command publishes. A new mutating route fails here until its events are reviewed and listed.
 */
const AUDITED: Readonly<Record<string, readonly string[]>> = {
  'POST /api-tokens': ['identity.api_token_created'],
  'POST /api-tokens/:id/revoke': ['identity.api_token_revoked'],
  'POST /auth/login': ['identity.logged_in'],
  'POST /auth/logout': ['identity.logged_out'],
  'POST /auth/mfa/disable': ['identity.mfa_disabled'],
  'POST /auth/mfa/enable': ['identity.mfa_enabled'],
  'POST /auth/mfa/recovery': ['identity.mfa_recovery_regenerated'],
  'POST /auth/mfa/setup': ['identity.mfa_setup_requested'],
  'POST /auth/register': ['identity.registered'],
  'POST /auth/reset': ['identity.password_reset'],
  'POST /auth/reset/request': ['identity.reset_requested'],
  'POST /auth/verification/request': ['identity.verify_requested'],
  'POST /auth/verify': ['identity.email_verified'],
  'POST /organizations': ['organization.created'],
  'POST /organizations/:organizationId/confirmations': ['confirmation.issued'],
  'POST /organizations/:organizationId/join-tokens': ['fleet.join_token.issued'],
  'POST /organizations/:organizationId/members': ['membership.added'],
  'POST /organizations/:organizationId/members/:membershipId/remove': ['membership.removed'],
  'POST /organizations/:organizationId/members/:membershipId/role': ['membership.role_changed'],
  'POST /organizations/:organizationId/nodes/:nodeId/remove': ['fleet.node.removed'],
  'POST /organizations/:organizationId/projects': ['project.created'],
  'POST /organizations/:organizationId/projects/:projectId/api-tokens/:id/revoke': [
    'identity.api_token_revoked',
  ],
  'POST /organizations/:organizationId/projects/:projectId/bindings': ['role_binding.assigned'],
  'POST /organizations/:organizationId/projects/:projectId/bindings/:membershipId/remove': [
    'role_binding.removed',
  ],
  'POST /organizations/:organizationId/projects/:projectId/environments': ['environment.created'],
  'POST /organizations/:organizationId/projects/:projectId/environments/:environmentId/bindings': [
    'role_binding.assigned',
  ],
  'POST /organizations/:organizationId/projects/:projectId/environments/:environmentId/bindings/:membershipId/remove':
    ['role_binding.removed'],
  'POST /organizations/:organizationId/projects/:projectId/environments/:environmentId/settings': [
    'environment.updated',
  ],
  'POST /organizations/:organizationId/projects/:projectId/settings': ['project.updated'],
  'POST /organizations/:organizationId/settings': ['organization.updated'],
  'POST /organizations/:organizationId/projects/:projectId/environments/:environmentId/secrets': [
    'secret.set',
  ],
  'POST /organizations/:organizationId/projects/:projectId/environments/:environmentId/secrets/:name/remove':
    ['secret.removed'],
};

/** Production sources of the API, without tests and generated code. */
function sources(directory: string): string {
  return readdirSync(directory)
    .map((entry) => join(directory, entry))
    .map((path) => {
      if (statSync(path).isDirectory())
        return path.endsWith('generated') || path.endsWith('testing') ? '' : sources(path);
      return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? readFileSync(path, 'utf8') : '';
    })
    .join('\n');
}

/**
 * An event name is emitted when the code spells it out, or builds it from its module prefix and
 * a literal last part (`identityEvent('registered')`, `` `membership.${action}` `` with
 * `'removed'`, `` `${purpose}_requested` ``).
 */
function emitted(code: string, event: string): boolean {
  const last = event.slice(event.lastIndexOf('.') + 1);
  const tail = last.slice(last.lastIndexOf('_') + 1);
  return [
    `'${event}'`,
    `'${last}'`,
    `\`${last}\``,
    `_${tail}\``,
    ...(last.includes('_') ? [`'${tail}'`] : []),
  ].some((form) => code.includes(form));
}

describe('audit coverage of state-changing routes', () => {
  let routes: { method: string; path: string }[];
  const code = sources(__dirname);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    routes = routeInventory(moduleRef.get(ModulesContainer), moduleRef.get(Reflector));
    await moduleRef.close();
  });

  it('declares the audit events of every mutating route, and nothing stale', () => {
    const mutating = routes
      .filter((route) => route.method !== 'GET')
      .map((route) => `${route.method} ${route.path}`);
    expect(mutating.length).toBeGreaterThan(20);
    for (const key of mutating) expect(AUDITED[key], `${key}: list its audit events`).toBeDefined();
    expect(Object.keys(AUDITED).filter((key) => !mutating.includes(key))).toEqual([]);
  });

  it('names only events that the code publishes', () => {
    for (const [route, events] of Object.entries(AUDITED)) {
      expect(events.length, route).toBeGreaterThan(0);
      for (const event of events) expect(emitted(code, event), `${route}: ${event}`).toBe(true);
    }
  });
});
