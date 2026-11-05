import { Client } from 'pg';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { SECRET_STORE, type SecretStore } from './application/ports';

const PLAINTEXT = 'postgres://fixture:very-private-value@db/app';

/** PLAN M3.7: write-only environment secrets. */
describe('environment secrets over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  const path = () => `${fixture.environment}/secrets`;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('versions secrets and never returns or stores the plaintext', async () => {
    const first = await fixture
      .post(path(), 'owner', { name: 'DATABASE_URL', value: PLAINTEXT })
      .expect(200);
    expect(first.body).toMatchObject({ name: 'DATABASE_URL', version: 1 });
    const second = await fixture
      .post(path(), 'environmentAdmin', { name: 'DATABASE_URL', value: `${PLAINTEXT}2` })
      .expect(200);
    expect(second.body).toMatchObject({
      version: 2,
      updatedBy: fixture.actors.environmentAdmin.id,
    });
    const listed = await fixture.get(path(), 'environmentViewer').expect(200);
    expect(listed.body).toEqual({
      items: [expect.objectContaining({ name: 'DATABASE_URL', version: 2 })],
    });
    for (const body of [first.body, second.body, listed.body])
      expect(JSON.stringify(body)).not.toContain('private');

    const admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    try {
      const rows = await admin.query<{ value_enc: Buffer }>('SELECT value_enc FROM secrets');
      expect(rows.rows.every((row) => !row.value_enc.toString('latin1').includes('private'))).toBe(
        true,
      );
    } finally {
      await admin.end();
    }
    const events = await auditLog().findMany({ where: { action: 'secret.set' } });
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('private');

    // Deployments decrypt through the store, inside the tenant context.
    const values = await fixture.app.get(PrismaUnitOfWork).runTenant(fixture.organizationId, () =>
      fixture.app.get<SecretStore>(SECRET_STORE).values(
        {
          organizationId: fixture.organizationId,
          projectId: fixture.projectId,
          environmentId: fixture.environmentId,
        },
        ['DATABASE_URL', 'MISSING'],
      ),
    );
    expect(values.map((value) => [value.name, value.version, value.value.expose()])).toEqual([
      ['DATABASE_URL', 2, `${PLAINTEXT}2`],
    ]);
  });

  it('keeps developers and viewers away from protected environment secrets', async () => {
    for (const actor of [
      'projectDeveloper',
      'environmentDeveloper',
      'environmentViewer',
      'member',
      'outsider',
    ] as const)
      await fixture.post(path(), actor, { name: 'API_KEY', value: 'x' }).expect(404);
    await fixture.get(path(), 'outsider').expect(404);
  });

  it('validates names and values and removes secrets once', async () => {
    for (const body of [
      { name: 'lowercase', value: 'x' },
      { name: 'A=B', value: 'x' },
      { name: 'TOKEN', value: '' },
      { name: 'TOKEN', value: 'x'.repeat(70_000) },
      { name: 'TOKEN' },
    ])
      await fixture.post(path(), 'owner', body).expect(400);
    await fixture.post(path(), 'owner', { name: 'TEMP', value: 'x' }).expect(200);
    await fixture.post(`${path()}/TEMP/remove`, 'owner', {}).expect(204);
    await fixture.post(`${path()}/TEMP/remove`, 'owner', {}).expect(404);
    expect(await auditLog().count({ where: { action: 'secret.removed' } })).toBe(1);
  });
});
