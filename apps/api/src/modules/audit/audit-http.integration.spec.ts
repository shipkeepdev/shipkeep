import { v7 as uuidv7 } from 'uuid';

import { tenantHttpFixture } from '../../testing/tenant-http';

import { AUDIT_EVENT_READER, type AuditEventReader } from './application/audit-event-reader';

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

  it("reads an environment's committed events for its stream, and only those", async () => {
    const reader = fixture.app.get<AuditEventReader>(AUDIT_EVENT_READER);
    const before = uuidv7();
    await fixture
      .post(`${fixture.environment}/secrets`, 'owner', { name: 'STREAMED', value: 'x' })
      .expect(200);
    const found = await reader.afterInEnvironment(
      fixture.organizationId,
      fixture.environmentId,
      before,
      10,
    );
    expect(found.map((event) => event.action)).toEqual(['secret.set']);
    expect(await reader.afterInEnvironment(fixture.organizationId, uuidv7(), before, 10)).toEqual(
      [],
    );
    expect(
      await reader.afterInEnvironment(
        fixture.organizationId,
        fixture.environmentId,
        found[0]?.id ?? before,
        10,
      ),
    ).toEqual([]);

    const stream = `${fixture.environment}/events`;
    await fixture.get(stream, 'environmentViewer').expect(406);
    await fixture.get(stream, 'outsider').expect(404);
  });

  // Last on purpose: it signs the environment viewer out.
  it('ends an open stream once its session is signed out, and sends nothing afterwards', async () => {
    const stream = fixture
      .get(`${fixture.environment}/events`, 'environmentViewer')
      .set('Accept', 'text/event-stream')
      .buffer(true)
      .parse((response, done) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => {
          done(null, text);
        });
      });
    const ended = stream.then((response) => response);
    // The stream is open under the viewer's session; sign that session out before the first poll.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fixture.post('/api/v1/auth/logout', 'environmentViewer', {}).expect(204);
    await fixture
      .post(`${fixture.environment}/secrets`, 'owner', { name: 'AFTER_LOGOUT', value: 'x' })
      .expect(200);
    // Without the session check the stream would run for an hour and this would time out.
    const response = await ended;
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).not.toContain('secret.set');
    expect(response.body).not.toContain('event: change');
  }, 20_000);
});
