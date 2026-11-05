import { tenantActors, tenantHttpFixture } from '../../testing/tenant-http';
import { ApiTokenCommands } from '../identity/application/api-token-commands';

import type { BindingViewDto, MemberViewDto } from './interface/administration.dto';

describe('administration directories over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    close = fixture.close;
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    await fixture.prisma.identityThrottle.deleteMany();
  });

  it('limits each directory to administrators of that exact scope', async () => {
    const { get, root, project, environment } = fixture;
    for (const actor of tenantActors) {
      await get(`${root}/members`, actor).expect(['owner', 'admin'].includes(actor) ? 200 : 404);
      await get(`${project}/bindings`, actor).expect(
        ['owner', 'admin', 'projectAdmin', 'restrictedAdmin'].includes(actor) ? 200 : 404,
      );
      await get(`${environment}/bindings`, actor).expect(
        ['owner', 'admin', 'projectAdmin', 'environmentAdmin'].includes(actor) ? 200 : 404,
      );
    }
  });

  it('returns metadata-only membership pages with exclusive cursors', async () => {
    const { get, root, actors } = fixture;
    const all = await get(`${root}/members`).expect(200).expect('Cache-Control', 'no-store');
    const items = (all.body as { items: MemberViewDto[] }).items;
    expect(items).toHaveLength(tenantActors.length - 1);
    expect(items.map((m) => m.userId)).not.toContain(actors.outsider.id);
    expect(Object.keys(items[0]).sort()).toEqual([
      'active',
      'createdAt',
      'email',
      'id',
      'orgRole',
      'organizationId',
      'updatedAt',
      'userId',
    ]);
    expect(items[0]).toMatchObject({
      active: true,
      createdAt: expect.stringMatching(/Z$/),
      updatedAt: expect.stringMatching(/Z$/),
    });
    const first = await get(`${root}/members?limit=1`).expect(200);
    expect(first.body).toEqual({ items: [items[0]], nextCursor: items[0].id });
    const next = await get(`${root}/members?limit=1&cursor=${items[0].id}`).expect(200);
    expect(next.body).toEqual({ items: [items[1]], nextCursor: items[1].id });
  });

  it('resolves overrides before pagination without exposing ungranted members', async () => {
    const { get, project, environment, actors, database, organizationId } = fixture;
    const projectRows = (
      (await get(`${project}/bindings`).expect(200)).body as { items: BindingViewDto[] }
    ).items;
    expect(projectRows.map((r) => r.userId).sort()).toEqual(
      ['owner', 'admin', 'projectAdmin', 'projectDeveloper', 'projectViewer', 'restrictedAdmin']
        .map((a) => actors[a as keyof typeof actors].id)
        .sort(),
    );
    const environmentRows = (
      (await get(`${environment}/bindings`, 'environmentAdmin').expect(200)).body as {
        items: BindingViewDto[];
      }
    ).items;
    const override = environmentRows.find((r) => r.userId === actors.restrictedAdmin.id);
    expect(override).toMatchObject({
      role: 'viewer',
      source: 'environment',
      directRole: 'viewer',
      inheritedRole: 'admin',
    });
    expect(environmentRows.find((r) => r.userId === actors.projectDeveloper.id)).toMatchObject({
      role: 'developer',
      source: 'project',
      directRole: null,
      inheritedRole: 'developer',
    });
    expect(environmentRows.find((r) => r.userId === actors.owner.id)).toMatchObject({
      role: 'admin',
      source: 'organization',
    });
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await get(
        `${environment}/bindings?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        'environmentAdmin',
      ).expect(200);
      const page = response.body as { items: BindingViewDto[]; nextCursor: string | null };
      paged.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
      expect(paged.length).toBeLessThanOrEqual(environmentRows.length);
    } while (cursor);
    expect(paged).toEqual(environmentRows.map((r) => r.id));
    // Disabled principals remain visible for administrators to remove their grants.
    await fixture.prisma.user.update({
      where: { id: actors.projectViewer.id },
      data: { status: 'disabled' },
    });
    try {
      const disabled = (
        (await get(`${project}/bindings`).expect(200)).body as { items: BindingViewDto[] }
      ).items;
      expect(disabled.find((r) => r.userId === actors.projectViewer.id)).toMatchObject({
        active: false,
      });
    } finally {
      await fixture.prisma.user.update({
        where: { id: actors.projectViewer.id },
        data: { status: 'active' },
      });
    }
    // Removing the caller's binding is effective on the next request, without stale role caching.
    const binding = await database.runTenant(organizationId, () =>
      database.client.roleBinding.findFirstOrThrow({
        where: { membershipId: actors.environmentAdmin.membershipId },
      }),
    );
    await database.runTenant(organizationId, () =>
      database.client.roleBinding.delete({ where: { id: binding.id } }),
    );
    try {
      await get(`${environment}/bindings`, 'environmentAdmin').expect(404);
    } finally {
      await database.runTenant(organizationId, () =>
        database.client.roleBinding.create({ data: binding }),
      );
    }
  });

  it('rejects bearer access, malformed pagination and mismatched ancestry uniformly', async () => {
    const {
      get,
      http,
      root,
      project,
      environment,
      owner,
      password,
      organizationId,
      foreignId,
      projectId,
      siblingProjectId,
      environmentId,
    } = fixture;
    const token = await fixture.app.get(ApiTokenCommands).create(
      owner,
      {
        name: 'Directory bearer denied',
        expiresAt: new Date(Date.now() + 3600000),
        scopes: [{ permission: 'member.manage', organizationId }],
      },
      password,
      {},
    );
    for (const path of [`${root}/members`, `${project}/bindings`, `${environment}/bindings`]) {
      await http().get(path).expect(401);
      await http().get(path).set('Authorization', `Bearer ${token.token.expose()}`).expect(401);
      for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'cursor=invalid', 'role=owner'])
        await get(`${path}?${query}`).expect(400);
    }
    for (const path of [
      `/api/v1/organizations/${foreignId}/projects/${projectId}/bindings`,
      `${root}/projects/${siblingProjectId}/environments/${environmentId}/bindings`,
      '/api/v1/organizations/invalid/members',
    ])
      expect((await get(path).expect(404)).body).toMatchObject({ code: 'resource_not_found' });
  });
});
