import type { ExecutionContext } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';
import type { Response } from 'express';
import { Client } from 'pg';
import { firstValueFrom, from } from 'rxjs';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { auditLog } from '../../testing/audit-log';
import { integrationApp } from '../../testing/integration-app';
import { CatalogQueries } from '../organizations/application/catalog-queries';
import { OrganizationCommands } from '../organizations/application/organization-commands';
import { ResourceCommands } from '../organizations/application/resource-commands';

import { ApiTokenAuthentication } from './application/api-token-authentication';
import { ApiTokenCommands } from './application/api-token-commands';
import { PASSWORD_HASHER, type PasswordHashing } from './application/identity-ports';
import type { SecurityContext } from './application/mfa-commands';
import { SessionCommands } from './application/session-commands';
import { IdentityReplayInterceptor } from './interface/identity-replay.interceptor';
import { RequireTenant } from './interface/route-access';
import {
  type ApiTokenPrincipal,
  type IdentityPrincipal,
  type IdentityRequest,
  resourceContext,
} from './interface/session-http';

const settingsHandler = () => undefined;
const undeclaredHandler = () => undefined;
RequireTenant('project.update', 'project')(settingsHandler);
class ResourceRoute {
  readonly settings = settingsHandler;
}

describe('resource retry interceptor with real authorization and PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  let admin: Client;
  let hash: Secret;
  let owner: SecurityContext;
  let target: { organizationId: string; projectId: string };
  let identity: ApiTokenPrincipal;
  const password = new Secret('resource retry fixture password');
  const settings = { name: 'Retried resource', slug: 'retried-resource' };
  beforeAll(async () => {
    fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    prisma = fixture.app.get(PrismaService);
    hash = await fixture.app.get<PasswordHashing>(PASSWORD_HASHER).hash(password);
  });
  afterAll(async () => {
    await admin.end();
    await close?.();
  });
  beforeEach(async () => {
    const userId = uuidv7();
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.com`,
        passwordHash: hash.expose(),
        status: 'active',
        emailVerifiedAt: new Date(),
      },
    });
    owner = { userId, securityVersion: 0, ip: '127.0.0.1', userAgent: 'Resource retry' };
    const organization = (
      await fixture.app
        .get(OrganizationCommands)
        .create(owner, { name: 'Retry fixture', slug: `retry-${userId.slice(-12)}` }, password, {})
    ).organization;
    owner = { ...owner, securityVersion: 1 };
    const project = await fixture.app
      .get(ResourceCommands)
      .createProject(owner, organization.id, { name: 'Initial', slug: 'initial' });
    target = { organizationId: organization.id, projectId: project.id };
    identity = await issue();
  });
  async function issue(): Promise<ApiTokenPrincipal> {
    const grant = await fixture.app.get(ApiTokenCommands).create(
      owner,
      {
        name: 'Retry credential',
        scopes: [{ permission: 'project.update', ...target }],
        expiresAt: new Date(Date.now() + 3600000),
      },
      password,
      {},
    );
    const { user, token } = await fixture.app
      .get(ApiTokenAuthentication)
      .authenticate(grant.token, 'project.update', target);
    return {
      kind: 'api_token',
      userId: user.id,
      email: user.email,
      tokenId: token.id,
      securityVersion: user.securityVersion,
      expiresAt: token.expiresAt,
      token: grant.token,
    };
  }
  async function session(): Promise<IdentityPrincipal> {
    const sessions = fixture.app.get(SessionCommands);
    const grant = await sessions.login({
      email: `${owner.userId}@example.com`,
      password,
      ip: owner.ip,
      userAgent: owner.userAgent,
    });
    const current = await sessions.authenticate(grant.token);
    return {
      kind: 'session',
      userId: owner.userId,
      email: grant.email,
      sessionId: current.session.id,
      securityVersion: owner.securityVersion,
      expiresAt: grant.expiresAt,
      token: grant.token,
    };
  }
  // Simulate the already-authenticated transport snapshot. This deliberately permits a stale
  // principal after a cache wait so the interceptor must revalidate it against real storage.
  async function run(
    key: string,
    actor: IdentityPrincipal = identity,
    body = settings,
    declared = true,
  ) {
    const input = {
      method: 'POST',
      path: `/api/v1/organizations/${target.organizationId}/projects/${target.projectId}/settings`,
      params: target,
      body,
      identity: actor,
      ip: owner.ip,
      headers: { 'idempotency-key': key, 'user-agent': owner.userAgent },
    } as unknown as IdentityRequest;
    const headers = new Map<string, unknown>();
    const response = {
      getHeader: (name: string) => headers.get(name.toLowerCase()),
      setHeader: (name: string, value: unknown) => headers.set(name.toLowerCase(), value),
      removeHeader: (name: string) => headers.delete(name.toLowerCase()),
    } as unknown as Response;
    const context = {
      getClass: () => ResourceRoute,
      getHandler: () => (declared ? settingsHandler : undeclaredHandler),
      switchToHttp: () => ({ getRequest: () => input, getResponse: () => response }),
    } as unknown as ExecutionContext;
    const value = await firstValueFrom(
      fixture.app.get(IdentityReplayInterceptor).intercept(context, {
        handle: () =>
          from(
            fixture.app
              .get(ResourceCommands)
              .updateProject(resourceContext(input), target, body)
              .then((project) => ({ id: project.id, name: project.name })),
          ),
      }),
    );
    return { value, replayed: headers.get('idempotency-replayed') };
  }

  it('runs identical concurrent resource mutations once and encrypts their retry snapshot', async () => {
    const key = uuidv7();
    const results = await Promise.all([run(key), run(key)]);
    expect(results.map((result) => result.replayed).sort()).toEqual(['false', 'true']);
    expect(results[0].value).toEqual({ id: target.projectId, name: settings.name });
    expect(results[1].value).toEqual(results[0].value);
    expect(
      await auditLog().count({
        where: { action: 'project.updated', targetId: target.projectId },
      }),
    ).toBe(1);
    const stored = JSON.stringify(await prisma.identityReplay.findMany());
    for (const privateValue of [key, settings.name, identity.token.expose()])
      expect(stored).not.toContain(privateValue);
  });

  it('binds retries to credential kind/id and the complete request body', async () => {
    const key = uuidv7();
    await run(key);
    await expect(run(key, await issue())).rejects.toMatchObject({ code: 'idempotency_key_reused' });
    await expect(run(key, await session())).rejects.toMatchObject({
      code: 'idempotency_key_reused',
    });
    await expect(run(key, identity, { ...settings, name: 'Changed' })).rejects.toMatchObject({
      code: 'idempotency_key_reused',
    });
    expect(
      await auditLog().count({
        where: { action: 'project.updated', targetId: target.projectId },
      }),
    ).toBe(1);
  });

  it('rejects cached results after revocation even with the earlier authenticated principal', async () => {
    const key = uuidv7();
    await run(key);
    await fixture.app.get(ApiTokenCommands).revoke(owner, identity.tokenId, password, {});
    await expect(run(key)).rejects.toThrow('Authentication failed.');
  });

  it('rechecks live permissions for both token and session cached results', async () => {
    const browser = await session();
    const keys = [uuidv7(), uuidv7()];
    await run(keys[0]);
    await run(keys[1], browser);
    const successor = uuidv7();
    await prisma.user.create({
      data: {
        id: successor,
        email: `${successor}@example.com`,
        passwordHash: hash.expose(),
        status: 'active',
        emailVerifiedAt: new Date(),
      },
    });
    const database = fixture.app.get(PrismaUnitOfWork);
    await database.runTenant(target.organizationId, async () => {
      await database.client.membership.create({
        data: {
          id: uuidv7(),
          organizationId: target.organizationId,
          userId: successor,
          orgRole: 'owner',
        },
      });
      // Change live policy without a version change to prove that checking version alone is insufficient.
      await database.client.membership.updateMany({
        where: { organizationId: target.organizationId, userId: owner.userId },
        data: { orgRole: 'member' },
      });
    });
    await expect(run(keys[0])).rejects.toThrow('Permission denied.');
    await expect(run(keys[1], browser)).rejects.toMatchObject({ code: 'resource_not_found' });
  });

  it('rejects cached results after account invalidation and rejects undeclared resource retries', async () => {
    const key = uuidv7();
    await run(key);
    await prisma.user.update({
      where: { id: owner.userId },
      data: { securityVersion: { increment: 1 } },
    });
    await expect(run(key)).rejects.toThrow('Authentication failed.');
    await expect(run(uuidv7(), identity, settings, false)).rejects.toThrow(
      'Authentication failed.',
    );
  });

  it('rolls back the resource and audit when encrypted retry persistence fails', async () => {
    const key = uuidv7();
    const before = await fixture.app.get(CatalogQueries).project(owner, target);
    await admin.query(
      'ALTER TABLE identity_replays ADD CONSTRAINT resource_retry_failure CHECK (false) NOT VALID',
    );
    try {
      await expect(run(key)).rejects.toThrow('Request retry storage temporarily unavailable.');
    } finally {
      await admin.query('ALTER TABLE identity_replays DROP CONSTRAINT resource_retry_failure');
    }
    expect(await fixture.app.get(CatalogQueries).project(owner, target)).toEqual(before);
    expect(
      await auditLog().count({
        where: { action: 'project.updated', targetId: target.projectId },
      }),
    ).toBe(0);
    await expect(run(key)).resolves.toMatchObject({ replayed: 'false' });
  });
});
