import { Secret, type ApiScope } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';
import { OrganizationCommands } from '../organizations/application/organization-commands';
import { ResourceCommands } from '../organizations/application/resource-commands';
import type { EnvironmentTarget } from '../organizations/application/resource-store';

import { AccountMutationAuthority } from './application/account-mutation-authority';
import { ApiTokenAuthentication } from './application/api-token-authentication';
import { ApiTokenCommands } from './application/api-token-commands';
import { PASSWORD_HASHER, type PasswordHashing } from './application/identity-ports';
import type { ResourceSecurityContext } from './application/resource-security-context';

describe('live tenant tokens under restricted PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let database: PrismaUnitOfWork;
  let prisma: PrismaService;
  let commands: ApiTokenCommands;
  let auth: ApiTokenAuthentication;
  let accounts: AccountMutationAuthority;
  let owner: ResourceSecurityContext;
  let member: ResourceSecurityContext;
  let target: EnvironmentTarget;
  let membershipId: string;
  const password = new Secret('live token fixture password');

  beforeAll(async () => {
    fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    database = fixture.app.get(PrismaUnitOfWork);
    prisma = fixture.app.get(PrismaService);
    commands = fixture.app.get(ApiTokenCommands);
    auth = fixture.app.get(ApiTokenAuthentication);
    accounts = fixture.app.get(AccountMutationAuthority);
    const hash = await fixture.app.get<PasswordHashing>(PASSWORD_HASHER).hash(password);
    const actors = await Promise.all(
      [0, 1].map(async () => {
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
        return { userId, securityVersion: 0, ip: '127.0.0.1', userAgent: 'Live token fixture' };
      }),
    );
    [owner, member] = actors;
    const { organization } = await fixture.app
      .get(OrganizationCommands)
      .create(owner, { name: 'Live tokens', slug: 'live-tokens' }, password, {});
    owner = { ...owner, securityVersion: 1 };
    const resources = fixture.app.get(ResourceCommands);
    const project = await resources.createProject(owner, organization.id, {
      name: 'Project',
      slug: 'project',
    });
    const environment = await resources.createEnvironment(
      owner,
      { organizationId: organization.id, projectId: project.id },
      { name: 'staging', protected: false },
    );
    target = {
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
    };
    membershipId = uuidv7();
    await database.runTenant(organization.id, async () => {
      await database.client.membership.create({
        data: {
          id: membershipId,
          organizationId: organization.id,
          userId: member.userId,
          orgRole: 'member',
        },
      });
      await database.client.roleBinding.create({
        data: {
          id: uuidv7(),
          organizationId: organization.id,
          projectId: project.id,
          membershipId,
          role: 'developer',
        },
      });
    });
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    await database.runTenant(target.organizationId, async () => {
      await database.client.environment.update({
        where: { id: target.environmentId },
        data: { protected: false },
      });
      await database.client.roleBinding.updateMany({
        where: { membershipId },
        data: { role: 'developer' },
      });
    });
  });

  async function issue(context: ResourceSecurityContext, scopes: readonly ApiScope[]) {
    return commands.create(
      context,
      {
        name: 'Live credential',
        scopes,
        expiresAt: new Date(Date.now() + 3600000),
      },
      password,
      {},
    );
  }

  it('requires live role/protection on issuance, authentication and private replay', async () => {
    const grant = await issue(member, [{ permission: 'deploy.run', ...target }]);
    await expect(auth.authenticate(grant.token, 'deploy.run', target)).resolves.toBeDefined();
    await database.runTenant(target.organizationId, () =>
      database.client.environment.update({
        where: { id: target.environmentId },
        data: { protected: true },
      }),
    );
    await expect(issue(member, [{ permission: 'deploy.run', ...target }])).rejects.toThrow(
      'Permission denied.',
    );
    await expect(auth.authenticate(grant.token, 'deploy.run', target)).rejects.toThrow(
      'Permission denied.',
    );
    await expect(auth.assertReplayAvailable(member.userId, 0, grant.token)).rejects.toThrow(
      'Permission denied.',
    );
    await database.runTenant(target.organizationId, async () => {
      await database.client.environment.update({
        where: { id: target.environmentId },
        data: { protected: false },
      });
      await database.client.roleBinding.updateMany({
        where: { membershipId },
        data: { role: 'viewer' },
      });
    });
    await expect(auth.authenticate(grant.token, 'deploy.run', target)).rejects.toThrow(
      'Permission denied.',
    );
    await expect(
      issue(member, [{ permission: 'project.create', organizationId: target.organizationId }]),
    ).rejects.toThrow('Permission denied.');
    await expect(
      issue(owner, [
        { permission: 'project.read', organizationId: target.organizationId, projectId: uuidv7() },
      ]),
    ).rejects.toThrow('Permission denied.');
  });

  it('requires the command permission and exact credential identity under its account lock', async () => {
    const project = { organizationId: target.organizationId, projectId: target.projectId };
    const grant = await issue(owner, [{ permission: 'project.read', ...project }]);
    const context = { ...owner, apiCredential: { id: grant.metadata.id, value: grant.token } };
    const read = { permission: 'project.read' as const, target: project };
    const operation = vi.fn(() => Promise.resolve('read result'));
    await expect(accounts.run(context, operation, read)).resolves.toBe('read result');
    operation.mockClear();
    await expect(accounts.run(context, operation)).rejects.toThrow('Authentication failed.');
    await expect(
      accounts.run(context, operation, { ...read, permission: 'project.update' }),
    ).rejects.toThrow('Permission denied.');
    await expect(
      accounts.run(context, operation, { ...read, target: { ...project, projectId: uuidv7() } }),
    ).rejects.toThrow('Permission denied.');
    await expect(
      accounts.run(
        { ...context, apiCredential: { ...context.apiCredential, id: uuidv7() } },
        operation,
        read,
      ),
    ).rejects.toThrow('Authentication failed.');
    await expect(
      accounts.run({ ...member, apiCredential: context.apiCredential }, operation, read),
    ).rejects.toThrow('Authentication failed.');
    await expect(accounts.reauthenticated(context, password, {}, operation)).rejects.toThrow(
      'Authentication failed.',
    );
    await expect(
      accounts.changePrivileges(context, member.userId, password, {}, () =>
        Promise.resolve({
          value: null,
          changed: true,
        }),
      ),
    ).rejects.toThrow('Authentication failed.');
    expect(operation).not.toHaveBeenCalled();
  });

  it('rejects revocation after transport authentication before entering the command', async () => {
    const grant = await issue(member, [{ permission: 'deploy.run', ...target }]);
    await auth.authenticate(grant.token, 'deploy.run', target);
    await commands.revoke(member, grant.metadata.id, password, {});
    const operation = vi.fn(() => Promise.resolve('must not execute'));
    await expect(
      accounts.run(
        { ...member, apiCredential: { id: grant.metadata.id, value: grant.token } },
        operation,
        { permission: 'deploy.run', target },
      ),
    ).rejects.toThrow('Authentication failed.');
    expect(operation).not.toHaveBeenCalled();
    expect(await prisma.user.findUnique({ where: { id: member.userId } })).toMatchObject({
      securityVersion: 0,
    });
  });

  it('retains account-only profile access without a tenant grant', async () => {
    const grant = await issue(member, [{ permission: 'profile.read' }]);
    await expect(auth.authenticate(grant.token, 'profile.read', {})).resolves.toBeDefined();
    await expect(auth.authenticate(grant.token, 'profile.read', target)).rejects.toThrow(
      'Permission denied.',
    );
  });
});
