import { ModulesContainer, Reflector } from '@nestjs/core';
import { allowsTenantAction } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { auditLog } from '../../testing/audit-log';
import { routeInventory, type RouteRow } from '../../testing/route-inventory';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { tenantActors, tenantPersona, tenantTarget } from '../../testing/tenant-personas';

/**
 * Tenant acceptance checkpoint (PLAN M2.3d4d). Every registered tenant route is called by every
 * fixture actor through the real guards, session checks and PostgreSQL policies. The expected
 * outcome comes from the pure domain policy, which `route-role-matrix.spec.ts` checks against
 * SPEC 7:
 * - an allowed GET answers 200;
 * - an allowed POST with an empty body or invalid resource id answers 400 without writing;
 * - a denied request answers 404, like a missing resource.
 */
describe('registered tenant routes for every role', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let applicationId: string;
  let deploymentId: string;
  const nodeId = uuidv7();
  const tokenId = uuidv7();

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    const application = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'matrix-app',
          build: { type: 'image', image: 'nginx:alpine' },
          run: { port: 80 },
        },
      })
      .expect(201);
    applicationId = (application.body as { id: string }).id;
    const queued = await fixture
      .post(`${fixture.environment}/applications/${applicationId}/deployments`, 'owner', {})
      .expect(201);
    deploymentId = (queued.body as { deployment: { id: string } }).deployment.id;
  });
  afterAll(async () => {
    await fixture.close();
  });

  function routePath(route: RouteRow, organizationId = fixture.organizationId): string {
    // Deploy/cancel and secret removal accept no body. Invalid non-scope path parameters
    // stop them at validation, after the real tenant guards have authorized the request.
    const path = `/api/v1${route.path}`
      .replace(':organizationId', organizationId)
      .replace(':projectId', fixture.projectId)
      .replace(':environmentId', fixture.environmentId)
      .replace(':membershipId', fixture.actors.member.membershipId)
      .replace(':nodeId', nodeId)
      .replace(':applicationId', route.method === 'POST' ? 'invalid' : applicationId)
      .replace(':deploymentId', route.method === 'POST' ? 'invalid' : deploymentId)
      .replace(':name', 'INVALID-NAME')
      .replace(':id', tokenId);
    expect(path, route.path).not.toContain(':');
    return path;
  }

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
    const auditsBefore = await auditLog().count();
    for (const route of routes) {
      if (route.access?.kind !== 'tenant') continue;
      const path = routePath(route);
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
    expect(await auditLog().count()).toBe(auditsBefore);
  });

  it('hides every tenant route of another organization, even from its owner elsewhere', async () => {
    const routes = routeInventory(
      fixture.app.get(ModulesContainer),
      fixture.app.get(Reflector),
    ).filter((route) => route.access?.kind === 'tenant' && route.method === 'GET');
    for (const route of routes) {
      // The foreign organization has no project or environment of the fixture; mixing ids must
      // never resolve across tenants.
      if (!route.path.includes(':projectId')) continue;
      const path = routePath(route, fixture.foreignId);
      await fixture.prisma.identityThrottle.deleteMany();
      expect((await fixture.get(path, 'owner')).status, route.path).toBe(404);
    }
  });
});
