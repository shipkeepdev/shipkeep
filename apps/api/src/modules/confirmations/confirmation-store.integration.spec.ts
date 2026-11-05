import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

import { CONFIRMATION_STORE, type ConfirmationStore } from './application/ports';

/** Single use and tenant isolation of confirmation tokens on the restricted login (SPEC 3.6). */
describe('confirmation token store against PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let admin: Client;
  let database: PrismaUnitOfWork;
  let store: ConfirmationStore;
  const orgs = [uuidv7(), uuidv7()];
  const user = uuidv7();
  const now = new Date();

  beforeAll(async () => {
    fixture = await integrationApp([], { restrictedDatabase: true });
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    database = fixture.app.get(PrismaUnitOfWork);
    store = fixture.app.get<ConfirmationStore>(CONFIRMATION_STORE);
    await admin.query(
      "INSERT INTO users (id,email,password_hash,status,email_verified_at,updated_at) VALUES ($1,$2,'fixture-hash','active',now(),now())",
      [user, `${user}@example.com`],
    );
    for (const [index, org] of orgs.entries()) {
      await admin.query('BEGIN');
      await admin.query(
        'INSERT INTO organizations (id,name,slug,updated_at) VALUES ($1,$2,$3,now())',
        [org, `Confirmations ${String(index)}`, `confirmations-${String(index)}`],
      );
      await admin.query(
        "INSERT INTO memberships (id,organization_id,user_id,org_role,updated_at) VALUES ($1,$2,$3,'owner',now())",
        [uuidv7(), org, user],
      );
      await admin.query('COMMIT');
    }
  });
  afterAll(async () => {
    await admin.end();
    await fixture.close();
  });

  async function issued(organizationId: string, target = uuidv7()) {
    const id = uuidv7();
    await database.runTenant(organizationId, () =>
      store.insert({
        id,
        organizationId,
        userId: user,
        action: 'node.remove',
        target,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 300_000),
        usedAt: null,
      }),
    );
    return { id, request: { organizationId, action: 'node.remove' as const, target } };
  }

  it('lets exactly one of two concurrent consumers spend a token', async () => {
    const token = await issued(orgs[0] ?? '');
    const results = await Promise.all(
      [0, 1].map(() =>
        database.runTenant(token.request.organizationId, () =>
          store.consume(token.id, token.request, user, new Date()),
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await admin.query<{ used_at: Date | null }>(
      'SELECT used_at FROM confirmation_tokens WHERE id=$1',
      [token.id],
    );
    expect(rows.rows[0]?.used_at).not.toBeNull();
  });

  it('never spends a token from another tenant, target, user or after expiry', async () => {
    const token = await issued(orgs[0] ?? '');
    for (const [org, request, requester, at] of [
      [orgs[1] ?? '', { ...token.request, organizationId: orgs[1] ?? '' }, user, now],
      [orgs[0] ?? '', { ...token.request, target: uuidv7() }, user, now],
      [orgs[0] ?? '', token.request, uuidv7(), now],
      [orgs[0] ?? '', token.request, user, new Date(now.getTime() + 300_000)],
    ] as const)
      expect(
        await database.runTenant(org, () => store.consume(token.id, request, requester, at)),
      ).toBe(false);
    // Outside any tenant context the runtime role sees no confirmation at all.
    expect(
      (await admin.query('SELECT id FROM confirmation_tokens WHERE id=$1', [token.id])).rowCount,
    ).toBe(1);
    await expect(
      database.runTenant(orgs[1] ?? '', () =>
        database.client.confirmationToken.count({ where: { id: token.id } }),
      ),
    ).resolves.toBe(0);
  });
});
