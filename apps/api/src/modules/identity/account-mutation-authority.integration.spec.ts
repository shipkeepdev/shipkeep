import { createEvent, Secret } from '@shipkeep/domain';
import * as OTPAuth from 'otpauth';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { auditLog } from '../../testing/audit-log';
import { integrationApp } from '../../testing/integration-app';

import { AccountMutationAuthority } from './application/account-mutation-authority';
import { PASSWORD_HASHER, type PasswordHashing } from './application/identity-ports';
import { MfaCommands, type SecurityContext } from './application/mfa-commands';
import { SessionCommands, type SessionGrant } from './application/session-commands';

describe('account mutation authority with restricted PostgreSQL', () => {
  let close: (() => Promise<void>) | undefined;
  let closeAdmin: (() => Promise<void>) | undefined;
  let admin: Client;
  let prisma: PrismaService;
  let database: PrismaUnitOfWork;
  let authority: AccountMutationAuthority;
  let sessions: SessionCommands;
  let mfa: MfaCommands;
  let events: DomainEventBus;
  let encoded: Secret;
  let passwords: PasswordHashing;
  let context: SecurityContext;
  let original: SessionGrant;
  const password = new Secret('account mutation fixture password');
  const client = { ip: '127.0.0.1', userAgent: 'Account authority fixture' };

  beforeAll(async () => {
    const fixture = await integrationApp([], { restrictedDatabase: true });
    close = fixture.close;
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    closeAdmin = () => admin.end();
    prisma = fixture.app.get(PrismaService);
    database = fixture.app.get(PrismaUnitOfWork);
    authority = fixture.app.get(AccountMutationAuthority);
    sessions = fixture.app.get(SessionCommands);
    mfa = fixture.app.get(MfaCommands);
    events = fixture.app.get(DomainEventBus);
    passwords = fixture.app.get<PasswordHashing>(PASSWORD_HASHER);
    encoded = await passwords.hash(password);
  });
  afterAll(async () => {
    await closeAdmin?.();
    await close?.();
  });
  beforeEach(async () => {
    const userId = uuidv7();
    const email = `${userId}@example.com`;
    await prisma.user.create({
      data: {
        id: userId,
        email,
        passwordHash: encoded.expose(),
        status: 'active',
        emailVerifiedAt: new Date(),
      },
    });
    original = await sessions.login({ email, password, ...client });
    context = { userId, securityVersion: 0, ...client };
  });

  it('joins the caller transaction and rejects invalid, stale or disabled actors', async () => {
    await authority.run(context, async () => {
      expect(database.client).not.toBe(prisma);
      await events.publish([event('test.authorized')]);
    });
    const operation = vi.fn(() => Promise.resolve());
    for (const invalid of [
      { ...context, userId: 'invalid' },
      { ...context, userId: uuidv7() },
      { ...context, securityVersion: -1 },
      { ...context, securityVersion: NaN },
      { ...context, securityVersion: 1 },
    ])
      await expect(authority.run(invalid, operation)).rejects.toThrow('Authentication failed.');
    await prisma.user.update({ where: { id: context.userId }, data: { status: 'disabled' } });
    await expect(authority.run(context, operation)).rejects.toThrow('Authentication failed.');
    expect(operation).not.toHaveBeenCalled();
    expect(
      await auditLog().count({
        where: { targetId: context.userId, action: 'test.authorized' },
      }),
    ).toBe(1);
  });

  it('requires fresh password proof and bounds rotation to the same proof callback', async () => {
    await expect(authority.rotate(context)).rejects.toThrow('Authentication failed.');
    await expect(
      authority.reauthenticated(context, new Secret('wrong fixture password'), {}, () =>
        authority.rotate(context),
      ),
    ).rejects.toThrow('Authentication failed.');
    const session = await authority.reauthenticated(context, password, {}, async () => {
      await expect(authority.rotate({ ...context, userId: uuidv7() })).rejects.toThrow(
        'Authentication failed.',
      );
      await expect(authority.rotate({ ...context, securityVersion: 1 })).rejects.toThrow(
        'Authentication failed.',
      );
      return authority.rotate(context);
    });
    await expect(sessions.authenticate(original.token)).rejects.toThrow('Authentication failed.');
    expect((await sessions.authenticate(session.token)).user.securityVersion).toBe(1);
    await expect(authority.rotate({ ...context, securityVersion: 1 })).rejects.toThrow(
      'Authentication failed.',
    );
  });

  it('requires MFA and rolls back proof, business writes, rotation and audit as one transaction', async () => {
    const now = new Date();
    const setup = await mfa.setup(context, password, now);
    const code = new Secret(
      new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(setup.secret.expose()),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
      }).generate({ timestamp: now.getTime() }),
    );
    const enabled = await mfa.enable(context, password, code, now);
    const active = { ...context, securityVersion: 1 };
    await expect(
      authority.reauthenticated(active, password, {}, () => authority.rotate(active)),
    ).rejects.toThrow('Authentication failed.');
    const factor = { recovery: enabled.recoveryCodes[0] };
    await admin.query(
      "ALTER TABLE audit_events ADD CONSTRAINT reject_authority_audit CHECK (action <> 'test.denied')",
    );
    try {
      await expect(
        authority.reauthenticated(active, password, factor, async () => {
          await database.client.user.update({
            where: { id: active.userId },
            data: { email: 'changed-by-rolled-back-command@example.com' },
          });
          await authority.rotate(active);
          await events.publish([event('test.denied')]);
        }),
      ).rejects.toThrow();
    } finally {
      await admin.query('ALTER TABLE audit_events DROP CONSTRAINT reject_authority_audit');
    }
    expect((await sessions.authenticate(enabled.session.token)).user.securityVersion).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: active.userId } })).email).toBe(
      original.email,
    );
    expect(
      await auditLog().count({
        where: { targetId: active.userId, action: 'identity.session_rotated' },
      }),
    ).toBe(1);
    const session = await authority.reauthenticated(active, password, factor, () =>
      authority.rotate(active),
    );
    expect((await sessions.authenticate(session.token)).user.securityVersion).toBe(2);
    await expect(
      authority.reauthenticated({ ...active, securityVersion: 2 }, password, factor, () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow('Authentication failed.');
  });

  it('keeps reauthentication proof private to its asynchronous request', async () => {
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = authority.reauthenticated(context, password, {}, async () => {
      entered();
      await resume;
      return authority.rotate(context);
    });
    await started;
    try {
      await expect(authority.rotate(context)).rejects.toThrow('Authentication failed.');
    } finally {
      release();
    }
    expect((await sessions.authenticate((await first).token)).user.securityVersion).toBe(1);
  });

  it('rejects a security-version change between password verification and the mutation lock', async () => {
    const verify = passwords.verify.bind(passwords);
    const spy = vi.spyOn(passwords, 'verify').mockImplementationOnce(async (hash, supplied) => {
      const matched = await verify(hash, supplied);
      await prisma.user.update({
        where: { id: context.userId },
        data: { securityVersion: { increment: 1 } },
      });
      return matched;
    });
    const operation = vi.fn(() => Promise.resolve());
    try {
      await expect(authority.reauthenticated(context, password, {}, operation)).rejects.toThrow(
        'Authentication failed.',
      );
    } finally {
      spy.mockRestore();
    }
    expect(operation).not.toHaveBeenCalled();
  });

  it('expires proof when the callback ends, including inherited detached async work', async () => {
    let release: () => void = () => undefined;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached: Promise<SessionGrant> | undefined;
    await authority.reauthenticated(context, password, {}, () => {
      detached = resume.then(() => authority.rotate(context));
      return Promise.resolve();
    });
    release();
    await expect(detached).rejects.toThrow('Authentication failed.');
    expect((await sessions.authenticate(original.token)).user.securityVersion).toBe(0);
  });

  function event(type: string) {
    return createEvent({
      type,
      actor: { kind: 'user', id: context.userId },
      target: { type: 'test', id: context.userId },
      payload: {},
    });
  }
});
