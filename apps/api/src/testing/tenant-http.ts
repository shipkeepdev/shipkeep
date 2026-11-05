import type { Server } from 'node:http';

import { Secret } from '@shipkeep/domain';
import request, { type Test } from 'supertest';
import { v7 as uuidv7 } from 'uuid';

import {
  PASSWORD_HASHER,
  type PasswordHashing,
} from '../modules/identity/application/identity-ports';
import type { SecurityContext } from '../modules/identity/application/mfa-commands';
import { SessionCommands } from '../modules/identity/application/session-commands';
import { cookiePolicy } from '../modules/identity/interface/session-http';
import { OrganizationCommands } from '../modules/organizations/application/organization-commands';
import { ResourceCommands } from '../modules/organizations/application/resource-commands';
import { AppConfig } from '../platform/config/app-config';
import { PrismaService } from '../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../platform/prisma/prisma-unit-of-work';

import { integrationApp } from './integration-app';

export const tenantActors = [
  'owner',
  'admin',
  'member',
  'projectAdmin',
  'projectDeveloper',
  'projectViewer',
  'environmentAdmin',
  'environmentDeveloper',
  'environmentViewer',
  'restrictedAdmin',
  'outsider',
] as const;
export type TenantActor = (typeof tenantActors)[number];

type TenantHttpFixture = Awaited<ReturnType<typeof integrationApp>> & {
  prisma: PrismaService;
  database: PrismaUnitOfWork;
  password: Secret;
  actors: Record<TenantActor, { id: string; email: string; membershipId: string }>;
  owner: SecurityContext;
  http: () => ReturnType<typeof request>;
  get: (path: string, actor?: TenantActor) => Test;
  organizationId: string;
  foreignId: string;
  projectId: string;
  siblingProjectId: string;
  environmentId: string;
  root: string;
  project: string;
  environment: string;
};

/** Restricted integration database and real credentials for HTTP role acceptance. */
export async function tenantHttpFixture(): Promise<TenantHttpFixture> {
  const fixture = await integrationApp([], { restrictedDatabase: true });
  try {
    const { app } = fixture;
    const prisma = app.get(PrismaService);
    const database = app.get(PrismaUnitOfWork);
    const password = new Secret('tenant HTTP fixture password');
    const origin = new URL(app.get(AppConfig).get('API_PUBLIC_URL')).origin;
    const actors = Object.fromEntries(
      tenantActors.map((actor) => {
        const id = uuidv7();
        return [actor, { id, email: `${id}@example.com`, membershipId: uuidv7() }];
      }),
    ) as Record<TenantActor, { id: string; email: string; membershipId: string }>;
    const hash = await app.get<PasswordHashing>(PASSWORD_HASHER).hash(password);
    await prisma.user.createMany({
      data: Object.values(actors).map(({ id, email }) => ({
        id,
        email,
        passwordHash: hash.expose(),
        status: 'active',
        emailVerifiedAt: new Date(),
      })),
    });
    let owner = {
      userId: actors.owner.id,
      securityVersion: 0,
      ip: '127.0.0.1',
      userAgent: 'Tenant HTTP',
    };
    const organizations = app.get(OrganizationCommands);
    const organizationId = (
      await organizations.create(owner, { name: 'Tenant', slug: 'tenant' }, password, {})
    ).organization.id;
    owner = { ...owner, securityVersion: 1 };
    const foreignId = (
      await organizations.create(owner, { name: 'Foreign', slug: 'foreign' }, password, {})
    ).organization.id;
    owner = { ...owner, securityVersion: 2 };
    const resources = app.get(ResourceCommands);
    const projectId = (
      await resources.createProject(owner, organizationId, { name: 'Project', slug: 'project' })
    ).id;
    const siblingProjectId = (
      await resources.createProject(owner, organizationId, { name: 'Sibling', slug: 'sibling' })
    ).id;
    const target = { organizationId, projectId };
    const environmentId = (await resources.createEnvironment(owner, target, { name: 'production' }))
      .id;
    await database.runTenant(organizationId, async () => {
      const membership = await database.client.membership.findFirstOrThrow({
        where: { userId: owner.userId },
      });
      actors.owner.membershipId = membership.id;
      await database.client.membership.createMany({
        data: tenantActors
          .filter((a) => a !== 'owner' && a !== 'outsider')
          .map((a) => ({
            id: actors[a].membershipId,
            organizationId,
            userId: actors[a].id,
            orgRole: a === 'admin' ? 'admin' : 'member',
          })),
      });
      for (const actor of tenantActors) {
        if (
          !actor.startsWith('project') &&
          !actor.startsWith('environment') &&
          actor !== 'restrictedAdmin'
        )
          continue;
        await database.client.roleBinding.create({
          data: {
            id: uuidv7(),
            ...target,
            membershipId: actors[actor].membershipId,
            environmentId: actor.startsWith('environment') ? environmentId : null,
            role: actor.endsWith('Developer')
              ? 'developer'
              : actor.endsWith('Viewer')
                ? 'viewer'
                : 'admin',
          },
        });
      }
      await database.client.roleBinding.create({
        data: {
          id: uuidv7(),
          ...target,
          environmentId,
          membershipId: actors.restrictedAdmin.membershipId,
          role: 'viewer',
        },
      });
    });
    const login = async (actor: TenantActor) => {
      const grant = await app
        .get(SessionCommands)
        .login({ email: actors[actor].email, password, ip: owner.ip, userAgent: owner.userAgent });
      return {
        cookie: `${cookiePolicy(origin).name}=${grant.token.expose()}`,
        csrf: grant.csrf.expose(),
      };
    };
    const sessions = Object.fromEntries(
      await Promise.all(tenantActors.map(async (actor) => [actor, await login(actor)])),
    ) as Record<TenantActor, { cookie: string; csrf: string }>;
    const http = () => request(app.getHttpServer() as Server);
    const root = `/api/v1/organizations/${organizationId}`;
    const project = `${root}/projects/${projectId}`;
    const environment = `${project}/environments/${environmentId}`;
    return {
      ...fixture,
      prisma,
      database,
      password,
      actors,
      owner,
      http,
      organizationId,
      foreignId,
      projectId,
      siblingProjectId,
      environmentId,
      root,
      project,
      environment,
      get: (path: string, actor: TenantActor = 'owner') =>
        http().get(path).set('Cookie', sessions[actor].cookie),
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
