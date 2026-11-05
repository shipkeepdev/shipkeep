import { tenantHttpFixture } from '../../testing/tenant-http';

interface AuditItem {
  id: string;
  action: string;
  targetId: string;
}
interface AuditPage {
  items: AuditItem[];
  nextCursor: string | null;
}

/** PLAN M2.4a: scoped audit reads and exports. */
describe('audit events over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  const events = (query = '', actor: Parameters<typeof fixture.get>[1] = 'owner') =>
    fixture.get(`${fixture.root}/audit-events${query}`, actor);

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('returns only the organization events, never account or other tenant events', async () => {
    const page = (await events().expect(200)).body as AuditPage;
    const actions = page.items.map((item) => item.action);
    expect(actions).toEqual(expect.arrayContaining(['organization.created', 'project.created']));
    expect(actions.some((action) => action.startsWith('identity.'))).toBe(false);
    expect(page.items.map((item) => item.targetId)).not.toContain(fixture.foreignId);
    const ids = page.items.map((item) => item.id);
    expect([...ids].sort().reverse()).toEqual(ids);
  });

  it('filters, paginates and validates queries', async () => {
    const created = (await events('?action=project.created').expect(200)).body as AuditPage;
    expect(created.items.length).toBeGreaterThan(1);
    expect(created.items.every((item) => item.action === 'project.created')).toBe(true);
    const first = (await events('?action=project.created&limit=1').expect(200)).body as AuditPage;
    expect(first.items).toHaveLength(1);
    const second = (
      await events(`?action=project.created&limit=1&cursor=${first.nextCursor ?? ''}`).expect(200)
    ).body as AuditPage;
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    const future = (await events('?from=2999-01-01T00:00:00Z').expect(200)).body as AuditPage;
    expect(future.items).toEqual([]);
    for (const query of ['?action=DROP%20TABLE', '?limit=101', '?from=yesterday', '?cursor=1'])
      await events(query).expect(400);
  });

  it('allows organization administrators only', async () => {
    await events('', 'admin').expect(200);
    for (const actor of ['member', 'projectAdmin', 'environmentAdmin', 'outsider'] as const)
      await events('', actor).expect(404);
  });

  it('exports matching events as JSON Lines', async () => {
    const response = await fixture
      .get(`${fixture.root}/audit-events/export?action=organization.created`, 'owner')
      .expect(200)
      .expect('Content-Type', /application\/x-ndjson/)
      .expect('X-Shipkeep-Truncated', 'false');
    const lines = response.text.trim().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as AuditItem).targetId)).toEqual([
      fixture.organizationId,
    ]);
    await fixture.get(`${fixture.root}/audit-events/export`, 'member').expect(404);
  });
});
