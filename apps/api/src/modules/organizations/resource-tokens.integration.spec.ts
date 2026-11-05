import { Secret, type ApiScope } from '@shipkeep/domain';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { auditLog } from '../../testing/audit-log';
import { integrationApp } from '../../testing/integration-app';
import { ApiTokenAuthentication } from '../identity/application/api-token-authentication';
import { ApiTokenCommands } from '../identity/application/api-token-commands';
import { PASSWORD_HASHER, type PasswordHashing } from '../identity/application/identity-ports';
import { ProjectApiTokenCommands } from '../identity/application/project-api-token-commands';
import type { ResourceSecurityContext } from '../identity/application/resource-security-context';

import { AdministrationQueries } from './application/administration-queries';
import { CatalogQueries } from './application/catalog-queries';
import { OrganizationCommands } from './application/organization-commands';
import { ResourceCommands } from './application/resource-commands';
import type { EnvironmentTarget } from './application/resource-store';

describe('resource commands with scoped API credentials', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let admin: Client;
  let prisma: PrismaService;
  let tokens: ApiTokenCommands;
  let resources: ResourceCommands;
  let organizations: OrganizationCommands;
  let catalog: CatalogQueries;
  let owner: ResourceSecurityContext;
  let organizationId: string;
  let target: EnvironmentTarget;
  const password = new Secret('resource token fixture password');
  const settings = { name: 'Token project', slug: 'token-project' };

  beforeAll(async () => {
    fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    prisma = fixture.app.get(PrismaService);
    tokens = fixture.app.get(ApiTokenCommands);
    resources = fixture.app.get(ResourceCommands);
    organizations = fixture.app.get(OrganizationCommands);
    catalog = fixture.app.get(CatalogQueries);
    const userId = uuidv7();
    const hash = await fixture.app.get<PasswordHashing>(PASSWORD_HASHER).hash(password);
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.com`,
        passwordHash: hash.expose(),
        status: 'active',
        emailVerifiedAt: new Date(),
      },
    });
    owner = { userId, securityVersion: 0, ip: '127.0.0.1', userAgent: 'Resource token fixture' };
    organizationId = (
      await organizations.create(
        owner,
        { name: 'Token organization', slug: 'token-organization' },
        password,
        {},
      )
    ).organization.id;
    owner = { ...owner, securityVersion: 1 };
  });
  afterAll(async () => {
    await admin.end();
    await close?.();
  });
  beforeEach(async () => {
    const project = await resources.createProject(owner, organizationId, {
      ...settings,
      slug: `project-${uuidv7().slice(-12)}`,
    });
    const environment = await resources.createEnvironment(
      owner,
      { organizationId, projectId: project.id },
      { name: 'staging' },
    );
    target = { organizationId, projectId: project.id, environmentId: environment.id };
  });
  const projectTarget = () => ({ organizationId, projectId: target.projectId });
  async function credential(scopes: readonly ApiScope[]): Promise<ResourceSecurityContext> {
    const grant = await tokens.create(
      owner,
      { name: 'Scoped command', scopes, expiresAt: new Date(Date.now() + 3600000) },
      password,
      {},
    );
    return { ...owner, apiCredential: { id: grant.metadata.id, value: grant.token } };
  }

  it('audits the credential for all five settings commands and permits scoped detail reads', async () => {
    const context = await credential([
      { permission: 'organization.update', organizationId },
      { permission: 'project.create', organizationId },
      { permission: 'project.update', ...projectTarget() },
      { permission: 'environment.create', ...projectTarget() },
      { permission: 'environment.update', ...target },
      { permission: 'organization.read', organizationId },
      { permission: 'project.read', ...projectTarget() },
      { permission: 'environment.read', ...target },
    ]);
    await organizations.update(context, organizationId, {
      name: 'Updated organization',
      slug: 'token-organization',
    });
    const project = await resources.createProject(context, organizationId, {
      ...settings,
      slug: 'token-created',
    });
    await resources.updateProject(context, projectTarget(), settings);
    const environment = await resources.createEnvironment(context, projectTarget(), {
      name: 'preview',
    });
    await resources.updateEnvironment(context, target, { name: 'production', protected: false });
    for (const [action, targetId] of [
      ['organization.updated', organizationId],
      ['project.created', project.id],
      ['project.updated', target.projectId],
      ['environment.created', environment.id],
      ['environment.updated', target.environmentId],
    ])
      expect(
        await auditLog().findFirst({
          where: { action, targetId, actorId: context.apiCredential?.id },
        }),
      ).toMatchObject({ actorKind: 'api_token', actorId: context.apiCredential?.id });
    expect(await catalog.organization(context, organizationId)).toMatchObject({
      name: 'Updated organization',
    });
    expect(await catalog.project(context, projectTarget())).toMatchObject({ name: settings.name });
    expect(await catalog.environment(context, target)).toMatchObject({
      name: 'production',
      protected: false,
    });
    expect(JSON.stringify(await auditLog().findMany())).not.toContain(
      context.apiCredential?.value.expose(),
    );
  });

  it('does not convert owner identity or a read scope into a settings permission', async () => {
    const context = await credential([
      { permission: 'organization.read', organizationId },
      { permission: 'project.read', ...projectTarget() },
      { permission: 'environment.read', ...target },
    ]);
    const before = await auditLog().count();
    for (const operation of [
      () => organizations.update(context, organizationId, { name: 'Denied', slug: 'denied' }),
      () => resources.createProject(context, organizationId, settings),
      () => resources.updateProject(context, projectTarget(), settings),
      () => resources.createEnvironment(context, projectTarget(), { name: 'denied' }),
      () => resources.updateEnvironment(context, target, { name: 'denied' }),
    ])
      await expect(operation()).rejects.toThrow('Permission denied.');
    expect(await auditLog().count()).toBe(before);
  });

  it('keeps catalog and administration collections session-only and rejects sibling scopes', async () => {
    const context = await credential([
      { permission: 'organization.read', organizationId },
      { permission: 'project.read', ...projectTarget() },
      { permission: 'environment.read', ...target },
      { permission: 'member.manage', organizationId },
    ]);
    const administration = fixture.app.get(AdministrationQueries);
    for (const operation of [
      () => catalog.organizations(context),
      () => catalog.projects(context, organizationId),
      () => catalog.environments(context, projectTarget()),
      () => administration.members(context, organizationId),
      () => administration.bindings(context, projectTarget()),
      () => organizations.create(context, { name: 'Denied', slug: 'denied' }, password, {}),
    ])
      await expect(operation()).rejects.toThrow('Authentication failed.');
    await expect(
      catalog.project(context, { ...projectTarget(), projectId: uuidv7() }),
    ).rejects.toThrow('Permission denied.');
    await expect(
      catalog.environment(context, { ...target, environmentId: uuidv7() }),
    ).rejects.toThrow('Permission denied.');
    await expect(catalog.organization(context, uuidv7())).rejects.toThrow('Permission denied.');
  });

  it('denies writes after transport authentication when that token has been revoked', async () => {
    const context = await credential([{ permission: 'project.update', ...projectTarget() }]);
    const key = context.apiCredential;
    if (!key) throw new Error('Missing fixture credential.');
    await fixture.app
      .get(ApiTokenAuthentication)
      .authenticate(key.value, 'project.update', projectTarget());
    await tokens.revoke(owner, key.id, password, {});
    await expect(resources.updateProject(context, projectTarget(), settings)).rejects.toThrow(
      'Authentication failed.',
    );
    expect(await auditLog().count({ where: { actorId: key.id } })).toBe(0);
  });

  it('holds the credential owner lock through the resource write and audit', async () => {
    const context = await credential([{ permission: 'project.update', ...projectTarget() }]);
    const key = context.apiCredential;
    if (!key) throw new Error('Missing fixture credential.');
    let reached = false;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unsubscribe = fixture.app.get(DomainEventBus).subscribe(async (event) => {
      if (event.type === 'project.updated' && event.actor.id === key.id) {
        reached = true;
        await held;
      }
    });
    const write = resources.updateProject(context, projectTarget(), {
      ...settings,
      slug: 'concurrent',
    });
    let revoke: Promise<void> | undefined;
    try {
      await vi.waitFor(
        () => {
          expect(reached).toBe(true);
        },
        { timeout: 3000, interval: 20 },
      );
      revoke = tokens.revoke(owner, key.id, password, {});
      await vi.waitFor(
        async () => {
          const result = await admin.query<{ count: string }>(
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE 'SELECT id FROM users%FOR UPDATE'",
          );
          expect(Number(result.rows[0]?.count)).toBeGreaterThan(0);
        },
        { timeout: 3000, interval: 20 },
      );
    } finally {
      release?.();
      unsubscribe();
      await Promise.all([write, revoke]);
    }
    expect(await catalog.project(owner, projectTarget())).toMatchObject({ slug: 'concurrent' });
    await expect(resources.updateProject(context, projectTarget(), settings)).rejects.toThrow(
      'Authentication failed.',
    );
  });

  it('rolls back the resource and token actor audit if an audit subscriber fails', async () => {
    const context = await credential([{ permission: 'project.update', ...projectTarget() }]);
    const original = await catalog.project(owner, projectTarget());
    const unsubscribe = fixture.app
      .get(DomainEventBus)
      .subscribe((event) =>
        event.type === 'project.updated'
          ? Promise.reject(new Error('Fixture audit failure.'))
          : Promise.resolve(),
      );
    try {
      await expect(resources.updateProject(context, projectTarget(), settings)).rejects.toThrow();
    } finally {
      unsubscribe();
    }
    expect(await catalog.project(owner, projectTarget())).toEqual(original);
    expect(await auditLog().count({ where: { actorId: context.apiCredential?.id } })).toBe(0);
  });
  it('binds project tokens to their project and deletes them with it', async () => {
    const auth = fixture.app.get(ApiTokenAuthentication);
    const create = (scopes: readonly ApiScope[]) =>
      tokens.create(
        owner,
        {
          name: 'Project token',
          scopes,
          expiresAt: new Date(Date.now() + 3600000),
          project: projectTarget(),
        },
        password,
        {},
      );
    for (const scopes of [
      [{ permission: 'organization.read' as const, organizationId }],
      [{ permission: 'profile.read' as const }],
      [{ permission: 'project.read' as const, organizationId, projectId: uuidv7() }],
    ])
      await expect(create(scopes)).rejects.toMatchObject({ code: 'invalid_api_token_scopes' });

    const grant = await create([
      { permission: 'project.read', ...projectTarget() },
      { permission: 'environment.read', ...target },
    ]);
    expect(grant.metadata.project).toEqual(projectTarget());
    await expect(
      auth.authenticate(grant.token, 'project.read', projectTarget()),
    ).resolves.toBeDefined();
    await expect(auth.authenticate(grant.token, 'environment.read', target)).resolves.toBeDefined();
    const sibling = await resources.createProject(owner, organizationId, {
      ...settings,
      slug: `sibling-${uuidv7().slice(-12)}`,
    });
    await expect(
      auth.authenticate(grant.token, 'project.read', { organizationId, projectId: sibling.id }),
    ).rejects.toMatchObject({ code: 'api_token_permission_denied' });
    await expect(
      auth.authenticate(grant.token, 'organization.read', { organizationId }),
    ).rejects.toMatchObject({ code: 'api_token_permission_denied' });
    expect(
      (
        await auditLog().findFirst({
          where: { action: 'identity.api_token_created', targetId: grant.metadata.id },
        })
      )?.metadata,
    ).toMatchObject({ projectId: target.projectId });

    // The project owns the credential's lifetime.
    await admin.query('BEGIN');
    await admin.query('DELETE FROM projects WHERE id=$1', [target.projectId]);
    await admin.query('COMMIT');
    expect(
      (await admin.query('SELECT id FROM api_tokens WHERE id=$1', [grant.metadata.id])).rowCount,
    ).toBe(0);
    await expect(
      auth.authenticate(grant.token, 'project.read', projectTarget()),
    ).rejects.toMatchObject({ code: 'authentication_failed' });
  });
  it('lets project administrators list and revoke project tokens they did not create', async () => {
    const hash = await fixture.app.get<PasswordHashing>(PASSWORD_HASHER).hash(password);
    const member = async (role: 'admin' | 'viewer'): Promise<ResourceSecurityContext> => {
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
      const membershipId = uuidv7();
      await admin.query('BEGIN');
      await admin.query(
        "INSERT INTO memberships (id,organization_id,user_id,org_role,updated_at) VALUES ($1,$2,$3,'member',now())",
        [membershipId, organizationId, userId],
      );
      await admin.query(
        'INSERT INTO role_bindings (id,organization_id,membership_id,project_id,role,updated_at) VALUES ($1,$2,$3,$4,$5,now())',
        [uuidv7(), organizationId, membershipId, target.projectId, role],
      );
      await admin.query('COMMIT');
      return { userId, securityVersion: 0, ip: '127.0.0.1', userAgent: `Project ${role}` };
    };
    const projectAdmin = await member('admin');
    const viewer = await member('viewer');
    const grant = await tokens.create(
      owner,
      {
        name: 'Deploy bot',
        scopes: [{ permission: 'project.read', ...projectTarget() }],
        expiresAt: new Date(Date.now() + 3600000),
        project: projectTarget(),
      },
      password,
      {},
    );
    const commands = fixture.app.get(ProjectApiTokenCommands);
    const listed = await commands.list(projectAdmin, projectTarget());
    expect(listed.map((item) => [item.id, item.createdBy, item.status])).toEqual([
      [grant.metadata.id, owner.userId, 'active'],
    ]);
    expect(JSON.stringify(listed)).not.toContain(grant.token.expose());
    await expect(commands.list(viewer, projectTarget())).rejects.toMatchObject({
      kind: 'not_found',
    });
    await expect(
      commands.revoke(viewer, projectTarget(), grant.metadata.id, password, {}),
    ).rejects.toMatchObject({ kind: 'not_found' });
    await expect(
      commands.revoke(
        projectAdmin,
        projectTarget(),
        grant.metadata.id,
        new Secret('wrong fixture password'),
        {},
      ),
    ).rejects.toMatchObject({ code: 'authentication_failed' });

    await commands.revoke(projectAdmin, projectTarget(), grant.metadata.id, password, {});
    await commands.revoke(projectAdmin, projectTarget(), grant.metadata.id, password, {});
    await expect(
      fixture.app
        .get(ApiTokenAuthentication)
        .authenticate(grant.token, 'project.read', projectTarget()),
    ).rejects.toMatchObject({ code: 'authentication_failed' });
    const events = await auditLog().findMany({
      where: { action: 'identity.api_token_revoked', targetId: grant.metadata.id },
    });
    expect(events.map((event) => [event.actorId, event.organizationId])).toEqual([
      [projectAdmin.userId, organizationId],
    ]);
    // Neither account's credentials changed.
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: projectAdmin.userId } })).securityVersion,
    ).toBe(0);
  });
});
