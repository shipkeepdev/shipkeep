import { ModulesContainer, Reflector } from '@nestjs/core';
import { allowsTenantAction } from '@shipkeep/domain';

import { routeInventory } from '../../testing/route-inventory';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { tenantActors, tenantPersona, tenantTarget } from '../../testing/tenant-personas';

/**
 * Tenant acceptance checkpoint (PLAN M2.3d4d). Every registered tenant route is called by every
 * fixture actor through the real guards, session checks and PostgreSQL policies. The expected
 * outcome comes from the pure domain policy, which `route-role-matrix.spec.ts` checks against
 * SPEC 7:
 * - an allowed GET answers 200;
 * - an allowed POST with an empty body reaches validation and answers 400, so nothing is written;
 * - a denied request answers 404, like a missing resource.
 */
describe('registered tenant routes for every role', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('answers each actor as the policy decides, without leaking hidden resources', async () => {
    const ids = {
      organizationId: fixture.organizationId,
      projectId: fixture.projectId,
      environmentId: fixture.environmentId,
    };
    const routes = routeInventory(
      fixture.app.get(ModulesContainer),
      fixture.app.get(Reflector),
    ).filter((route) => route.access?.kind === 'tenant');
    expect(routes.length).toBeGreaterThan(15);
    const auditsBefore = await fixture.prisma.auditEvent.count();
    for (const route of routes) {
      if (route.access?.kind !== 'tenant') continue;
      const path = `/api/v1${route.path}`
        .replace(':organizationId', ids.organizationId)
        .replace(':projectId', ids.projectId)
        .replace(':environmentId', ids.environmentId)
        .replace(':membershipId', fixture.actors.member.membershipId);
      expect(path, route.path).not.toContain(':');
      for (const actor of tenantActors) {
        const allowed = allowsTenantAction(
          tenantPersona(actor, ids),
          route.access.permission,
          tenantTarget(route.access.scope, ids),
        );
        // Password-proof routes share a per-account attempt limit; keep each call independent.
        await fixture.prisma.identityThrottle.deleteMany();
        const response =
          route.method === 'GET'
            ? await fixture.get(path, actor)
            : await fixture.post(path, actor, {});
        const expected = !allowed ? 404 : route.method === 'GET' ? 200 : 400;
        expect(response.status, `${route.method} ${route.path} as ${actor}`).toBe(expected);
      }
    }
    // Neither denied calls nor rejected bodies change state.
    expect(await fixture.prisma.auditEvent.count()).toBe(auditsBefore);
  });

  it('hides every tenant route of another organization, even from its owner elsewhere', async () => {
    const routes = routeInventory(
      fixture.app.get(ModulesContainer),
      fixture.app.get(Reflector),
    ).filter((route) => route.access?.kind === 'tenant' && route.method === 'GET');
    for (const route of routes) {
      // The foreign organization has no project or environment of the fixture; mixing ids must
      // never resolve across tenants.
      const path = `/api/v1${route.path}`
        .replace(':organizationId', fixture.foreignId)
        .replace(':projectId', fixture.projectId)
        .replace(':environmentId', fixture.environmentId)
        .replace(':membershipId', fixture.actors.member.membershipId);
      if (!route.path.includes(':projectId')) continue;
      await fixture.prisma.identityThrottle.deleteMany();
      expect((await fixture.get(path, 'owner')).status, route.path).toBe(404);
    }
  });
});
