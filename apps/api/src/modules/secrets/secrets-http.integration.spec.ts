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

  /**
   * Runs `between` once, right before the next removal deletes the row it read: the removal has
   * read its version, and `between` commits on other connections before the delete runs (#349).
   */
  function pauseNextRemoval(between: () => Promise<unknown>) {
    const database = fixture.app.get(PrismaUnitOfWork);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a getter, called with its receiver below
    const original = Object.getOwnPropertyDescriptor(PrismaUnitOfWork.prototype, 'client')?.get;
    let pending = true;
    const spy = vi.spyOn(database, 'client', 'get').mockImplementation(function (
      this: PrismaUnitOfWork,
    ) {
      const client = original?.call(this) as PrismaUnitOfWork['client'];
      return new Proxy(client, {
        get(target, property, receiver) {
          const value: unknown = Reflect.get(target, property, receiver);
          if (property !== 'secret') return value;
          return new Proxy(value as object, {
            get(secrets, method, inner) {
              const fn: unknown = Reflect.get(secrets, method, inner);
              if (method !== 'deleteMany' || !pending || typeof fn !== 'function') return fn;
              return async (...args: unknown[]) => {
                pending = false;
                await between();
                return (fn as (...a: unknown[]) => Promise<unknown>).apply(secrets, args);
              };
            },
          });
        },
      });
    });
    return () => {
      spy.mockRestore();
    };
  }

  it('refuses a removal when another account rotated the secret after it was read', async () => {
    await fixture.post(path(), 'owner', { name: 'ROTATED', value: 'one' }).expect(200);
    const removedBefore = await auditLog().count({ where: { action: 'secret.removed' } });
    const restore = pauseNextRemoval(() =>
      fixture.post(path(), 'environmentAdmin', { name: 'ROTATED', value: 'two' }).expect(200),
    );
    try {
      await fixture.post(`${path()}/ROTATED/remove`, 'owner', {}).expect(409);
    } finally {
      restore();
    }
    // Version 2 is kept, and no removal was recorded.
    const listed = await fixture.get(path(), 'owner').expect(200);
    expect((listed.body as { items: unknown[] }).items).toContainEqual(
      expect.objectContaining({ name: 'ROTATED', version: 2 }),
    );
    expect(await auditLog().count({ where: { action: 'secret.removed' } })).toBe(removedBefore);
  });

  it('lets only one of two concurrent removals succeed, with one audit event', async () => {
    await fixture.post(path(), 'owner', { name: 'RACED', value: 'one' }).expect(200);
    const removedBefore = await auditLog().count({ where: { action: 'secret.removed' } });
    let second: number | undefined;
    const restore = pauseNextRemoval(async () => {
      second = (await fixture.post(`${path()}/RACED/remove`, 'environmentAdmin', {})).status;
    });
    let first: number;
    try {
      first = (await fixture.post(`${path()}/RACED/remove`, 'owner', {})).status;
    } finally {
      restore();
    }
    expect([first, second].sort()).toEqual([204, 409]);
    expect(await auditLog().count({ where: { action: 'secret.removed' } })).toBe(removedBefore + 1);
    const listed = await fixture.get(path(), 'owner').expect(200);
    expect((listed.body as { items: unknown[] }).items).not.toContainEqual(
      expect.objectContaining({ name: 'RACED' }),
    );
  });
});
