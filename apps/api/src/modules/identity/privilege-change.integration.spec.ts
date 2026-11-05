import { createEvent, Secret } from '@shipkeep/domain';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

import { AccountMutationAuthority } from './application/account-mutation-authority';
import { ApiTokenAuthentication } from './application/api-token-authentication';
import { ApiTokenCommands } from './application/api-token-commands';
import { PASSWORD_HASHER, type PasswordHashing } from './application/identity-ports';
import { MfaCommands, type SecurityContext } from './application/mfa-commands';
import { SessionCommands } from './application/session-commands';

describe('ordered privilege changes against restricted PostgreSQL', () => {
  let close: (() => Promise<void>) | undefined;
  let admin: Client;
  let prisma: PrismaService;
  let database: PrismaUnitOfWork;
  let authority: AccountMutationAuthority;
  let sessions: SessionCommands;
  let tokens: ApiTokenCommands;
  let tokenAuth: ApiTokenAuthentication;
  let events: DomainEventBus;
  let mfa: MfaCommands;
  let hash: Secret;
  const password = new Secret('privilege change fixture password');
  const client = { ip: '127.0.0.1', userAgent: 'Privilege fixture' };

  beforeAll(async () => {
    const fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    prisma = fixture.app.get(PrismaService);
    database = fixture.app.get(PrismaUnitOfWork);
    authority = fixture.app.get(AccountMutationAuthority);
    sessions = fixture.app.get(SessionCommands);
    tokens = fixture.app.get(ApiTokenCommands);
    tokenAuth = fixture.app.get(ApiTokenAuthentication);
    events = fixture.app.get(DomainEventBus);
    mfa = fixture.app.get(MfaCommands);
    hash = await fixture.app.get<PasswordHashing>(PASSWORD_HASHER).hash(password);
  });
  afterAll(async () => {
    await admin.end();
    await close?.();
  });

  it('normalizes verified-account lookup without returning password material or inactive accounts', async () => {
    const actor = await account();
    expect(
      await authority.findVerifiedAccount(`  ${actor.userId.toUpperCase()}@EXAMPLE.COM  `),
    ).toEqual({ userId: actor.userId, email: `${actor.userId}@example.com`, active: true });
    expect(await authority.findVerifiedAccount('missing@example.com')).toBeNull();
    await prisma.user.update({ where: { id: actor.userId }, data: { status: 'disabled' } });
    expect(await authority.findVerifiedAccount(`${actor.userId}@example.com`)).toBeNull();
    await expect(authority.findVerifiedAccount('invalid')).rejects.toMatchObject({
      code: 'invalid_email',
    });
  });

  it('invalidates the affected account sessions and tokens while preserving the administrator session', async () => {
    const actor = await account();
    const affected = await account();
    const callerSession = await login(actor);
    const old = await login(affected);
    const token = await tokens.create(
      affected,
      {
        name: 'Fixture',
        scopes: [{ permission: 'profile.read' }],
        expiresAt: new Date(Date.now() + 600000),
      },
      password,
      {},
    );
    const result = await authority.changePrivileges(
      actor,
      affected.userId,
      password,
      {},
      async (subject) => {
        expect(subject).toEqual({
          userId: affected.userId,
          email: `${affected.userId}@example.com`,
          active: true,
        });
        expect(database.client).not.toBe(prisma);
        await audit(actor, affected.userId);
        return { value: 'updated', changed: true };
      },
    );
    expect(result).toEqual({ value: 'updated' });
    await expect(sessions.authenticate(old.token)).rejects.toThrow('Authentication failed.');
    await expect(tokenAuth.authenticate(token.token, 'profile.read', {})).rejects.toThrow(
      'Authentication failed.',
    );
    expect((await sessions.authenticate(callerSession.token)).user.securityVersion).toBe(0);
    expect(
      await prisma.auditEvent.findFirst({
        where: { targetId: affected.userId, action: 'identity.permissions_changed' },
      }),
    ).toMatchObject({ actorId: actor.userId });
  });

  it('rotates self-changes, leaves idempotent no-ops unchanged and rejects wrong proof or targets', async () => {
    const actor = await account();
    const old = await login(actor);
    const callback = vi.fn(() => Promise.resolve({ value: 'unchanged', changed: false }));
    expect(await authority.changePrivileges(actor, actor.userId, password, {}, callback)).toEqual({
      value: 'unchanged',
    });
    expect((await sessions.authenticate(old.token)).user.securityVersion).toBe(0);
    expect(
      await prisma.auditEvent.count({
        where: { targetId: actor.userId, action: 'identity.privilege_change_confirmed' },
      }),
    ).toBe(1);
    const result = await authority.changePrivileges(actor, actor.userId, password, {}, async () => {
      await audit(actor, actor.userId);
      return { value: 'changed', changed: true };
    });
    expect(result.session).toBeDefined();
    if (!result.session) throw new Error('Missing fixture session');
    expect((await sessions.authenticate(result.session.token)).user.securityVersion).toBe(1);
    await expect(sessions.authenticate(old.token)).rejects.toThrow('Authentication failed.');
    for (const id of ['invalid', uuidv7()])
      await expect(
        authority.changePrivileges({ ...actor, securityVersion: 1 }, id, password, {}, callback),
      ).rejects.toThrow('Authentication failed.');
    await expect(
      authority.changePrivileges(
        { ...actor, securityVersion: 1 },
        actor.userId,
        new Secret('wrong'),
        {},
        callback,
      ),
    ).rejects.toThrow('Authentication failed.');
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('rolls back both application writes and credential invalidation when its identity audit fails', async () => {
    const actor = await account();
    const affected = await account();
    const old = await login(affected);
    await admin.query(
      "ALTER TABLE audit_events ADD CONSTRAINT reject_privilege_audit CHECK (action <> 'identity.permissions_changed') NOT VALID",
    );
    try {
      await expect(
        authority.changePrivileges(actor, affected.userId, password, {}, async () => {
          await database.client.user.update({
            where: { id: affected.userId },
            data: { email: 'rolled-back-privilege@example.com' },
          });
          await audit(actor, affected.userId);
          return { value: null, changed: true };
        }),
      ).rejects.toThrow();
    } finally {
      await admin.query('ALTER TABLE audit_events DROP CONSTRAINT reject_privilege_audit');
    }
    expect((await sessions.authenticate(old.token)).user).toMatchObject({
      securityVersion: 0,
      email: `${affected.userId}@example.com`,
    });
    expect(
      await prisma.auditEvent.count({
        where: { targetId: affected.userId, action: 'test.role_changed' },
      }),
    ).toBe(0);
  });

  it('serializes reciprocal changes without deadlock and rejects the now-stale second actor', async () => {
    const first = await account();
    const second = await account();
    await admin.query('BEGIN');
    await admin.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
      [first.userId, second.userId].sort()[0],
    ]);
    const operation = () => Promise.resolve({ value: null, changed: true });
    const results = Promise.allSettled([
      authority.changePrivileges(first, second.userId, password, {}, operation),
      authority.changePrivileges(second, first.userId, password, {}, operation),
    ]);
    try {
      await vi.waitFor(
        async () => {
          await admin.query('SELECT pg_stat_clear_snapshot()');
          const waiting = await admin.query<{ count: string }>(
            "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM users WHERE id =%FOR UPDATE%'",
          );
          expect(Number(waiting.rows[0].count)).toBeGreaterThanOrEqual(2);
        },
        { timeout: 5000, interval: 25 },
      );
    } finally {
      await admin.query('ROLLBACK');
      await results;
    }
    const completed = await results;
    expect(completed.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(completed.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'authentication_failed' },
    });
  });

  it('requires configured MFA and audits proof consumption even for a no-op, with atomic rollback', async () => {
    const actor = await account();
    const affected = await account();
    const now = new Date();
    const setup = await mfa.setup(actor, password, now);
    const code = new Secret(
      new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(setup.secret.expose()),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
      }).generate({ timestamp: now.getTime() }),
    );
    const enabled = await mfa.enable(actor, password, code, now);
    const active = { ...actor, securityVersion: 1 };
    const operation = vi.fn(() => Promise.resolve({ value: null, changed: false }));
    await expect(
      authority.changePrivileges(active, affected.userId, password, {}, operation),
    ).rejects.toThrow('Authentication failed.');
    expect(operation).not.toHaveBeenCalled();
    const factor = { recovery: enabled.recoveryCodes[0] };
    await admin.query(
      "ALTER TABLE audit_events ADD CONSTRAINT reject_privilege_confirmation CHECK (action <> 'identity.privilege_change_confirmed') NOT VALID",
    );
    try {
      await expect(
        authority.changePrivileges(active, affected.userId, password, factor, operation),
      ).rejects.toThrow();
    } finally {
      await admin.query('ALTER TABLE audit_events DROP CONSTRAINT reject_privilege_confirmation');
    }
    expect(
      await authority.changePrivileges(active, affected.userId, password, factor, operation),
    ).toEqual({ value: null });
    expect((await sessions.authenticate(enabled.session.token)).user.securityVersion).toBe(1);
    expect(
      await prisma.auditEvent.count({
        where: { targetId: affected.userId, action: 'identity.privilege_change_confirmed' },
      }),
    ).toBe(1);
    await expect(
      authority.changePrivileges(active, affected.userId, password, factor, operation),
    ).rejects.toThrow('Authentication failed.');
  });

  async function account(): Promise<SecurityContext> {
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
    return { userId, securityVersion: 0, ...client };
  }
  function login(actor: SecurityContext) {
    return sessions.login({ email: `${actor.userId}@example.com`, password, ...client });
  }
  function audit(actor: SecurityContext, userId: string) {
    return events.publish([
      createEvent({
        type: 'test.role_changed',
        actor: { kind: 'user', id: actor.userId },
        target: { type: 'user', id: userId },
        payload: {},
      }),
    ]);
  }
});
