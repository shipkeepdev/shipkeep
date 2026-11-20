import { PassThrough } from 'node:stream';

import { NotFoundError, Secret } from '@shipkeep/domain';
import { Client } from 'pg';

import { runOperatorCommand } from '../../operator';
import { integrationApp } from '../../testing/integration-app';
import { hashJoinToken } from '../fleet/domain/join-token';
import { OperatorAccountCommands } from '../identity/application/operator-account-commands';

/** ADR 0021: the single-machine installer creates the first organization and a join token. */
describe('operator commands of the single-machine installer, against PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  /** The owner's connection: it reads past row security, to check what the command wrote. */
  let owner: Client;

  beforeAll(async () => {
    // Organizations and join tokens are tenant rows: the restricted role, as in production.
    fixture = await integrationApp([], { restrictedDatabase: true });
    owner = new Client({ connectionString: fixture.databaseUrl });
    await owner.connect();
  });
  afterAll(async () => {
    await owner.end();
    await fixture.close();
  });

  const run = async (command: Parameters<typeof runOperatorCommand>[1]): Promise<string> => {
    const output = new PassThrough();
    await runOperatorCommand(fixture.app, command, undefined, output, new PassThrough());
    const written: unknown = output.read();
    return Buffer.isBuffer(written) ? written.toString() : '';
  };

  it('creates the organization owned by the account, then a join token for it, both audited as the system', async () => {
    const account = await fixture.app
      .get(OperatorAccountCommands)
      .create('installer-owner@example.com', new Secret('first passphrase of the owner'));

    const said = await run({
      action: 'organization-create',
      name: 'Atelier Nord',
      slug: 'atelier-nord',
      owner: 'Installer-Owner@example.com',
    });
    const organizationId = /^Organization created: ([0-9a-f-]{36})\n$/.exec(said)?.[1] ?? '';
    expect(organizationId).not.toBe('');
    const membership = await owner.query<{ user_id: string; org_role: string }>(
      'SELECT user_id, org_role FROM memberships WHERE organization_id = $1',
      [organizationId],
    );
    expect(membership.rows).toEqual([{ user_id: account.id, org_role: 'owner' }]);
    const audit = async (action: string) =>
      (
        await owner.query<{ actor_kind: string }>(
          'SELECT actor_kind FROM audit_events WHERE organization_id = $1 AND action = $2',
          [organizationId, action],
        )
      ).rows.map((row) => row.actor_kind);
    expect(await audit('organization.created')).toEqual(['system']);

    const token = (await run({ action: 'join-token', organizationId })).trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await owner.query<{ token_hash: string; created_by: string | null }>(
      'SELECT token_hash, created_by FROM join_tokens WHERE organization_id = $1',
      [organizationId],
    );
    expect(stored.rows).toEqual([{ token_hash: hashJoinToken(token), created_by: null }]);
    expect(await audit('fleet.join_token.issued')).toEqual(['system']);

    expect(await run({ action: 'ca-fingerprint' })).toMatch(/^sha256:[0-9a-f]{64}\n$/);
  });

  it('refuses an owner that does not exist, and creates nothing', async () => {
    const count = async () =>
      Number(
        (await owner.query<{ n: string }>('SELECT count(*) AS n FROM organizations')).rows[0]?.n,
      );
    const before = await count();
    await expect(
      run({
        action: 'organization-create',
        name: 'Nobody',
        slug: 'nobody',
        owner: 'nobody@example.com',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await count()).toBe(before);
  });
});
