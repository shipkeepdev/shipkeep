import { Secret } from '@shipkeep/domain';
import * as OTPAuth from 'otpauth';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

import { PASSWORD_HASHER, type PasswordHashing } from './application/identity-ports';
import { MfaCommands, type SecurityContext } from './application/mfa-commands';
import { MFA_STORE, type MfaStore } from './application/mfa-store';
import { SessionCommands, type SessionGrant } from './application/session-commands';
import { PrismaIdentityStore } from './infrastructure/prisma-identity.store';

describe('audited MFA management', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let users: PrismaIdentityStore;
  let commands: MfaCommands;
  let sessions: SessionCommands;
  let mfa: MfaStore;
  let passwords: PasswordHashing;
  let now: Date;
  let context: SecurityContext;
  let original: SessionGrant;
  const password = new Secret('correct horse management password');
  const client = { ip: '127.0.0.1', userAgent: 'MFA management fixture' };
  const code = (secret: Secret, time = now) =>
    new Secret(
      new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(secret.expose()),
        digits: 6,
        period: 30,
        algorithm: 'SHA1',
      }).generate({ timestamp: time.getTime() }),
    );

  beforeAll(async () => {
    fixture = await integrationApp();
    close = fixture.close;
    users = new PrismaIdentityStore(fixture.app.get(PrismaUnitOfWork));
    commands = fixture.app.get(MfaCommands);
    sessions = fixture.app.get(SessionCommands);
    mfa = fixture.app.get<MfaStore>(MFA_STORE);
    passwords = fixture.app.get<PasswordHashing>(PASSWORD_HASHER);
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    const id = uuidv7();
    const email = `${id}@example.com`;
    now = new Date();
    await users.insertUser({
      id,
      email,
      passwordHash: await passwords.hash(password),
      status: 'active',
      emailVerifiedAt: now,
      securityVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    original = await sessions.login({ email, password, ...client }, now);
    context = { userId: id, securityVersion: 0, ...client };
  });

  async function enable() {
    const setup = await commands.setup(context, password, now);
    const enabled = await commands.enable(context, password, code(setup.secret), now);
    return { setup, enabled, active: { ...context, securityVersion: 1 } };
  }

  it('requires reauthentication, activates once and rotates the session before returning recovery codes', async () => {
    await expect(
      commands.setup(context, new Secret('wrong management password'), now),
    ).rejects.toThrow('Authentication failed.');
    expect(await mfa.find(context.userId)).toBeNull();
    const setup = await commands.setup(context, password, now);
    expect(JSON.stringify(setup)).not.toContain(setup.secret.expose());
    expect(setup.uri.expose()).toContain('otpauth://totp/');
    await expect(commands.enable(context, password, new Secret('invalid'), now)).rejects.toThrow(
      'Authentication failed.',
    );
    const results = await Promise.allSettled(
      [0, 1].map(() => commands.enable(context, password, code(setup.secret), now)),
    );
    const winner = results.find((result) => result.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('missing enabled fixture');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(winner.value.recoveryCodes).toHaveLength(10);
    expect(new Set(winner.value.recoveryCodes.map((value) => value.expose())).size).toBe(10);
    await expect(sessions.authenticate(original.token, undefined, now)).rejects.toThrow(
      'Authentication failed.',
    );
    expect(
      (await sessions.authenticate(winner.value.session.token, undefined, now)).user
        .securityVersion,
    ).toBe(1);
    await expect(commands.setup({ ...context, securityVersion: 1 }, password, now)).rejects.toThrow(
      'Disable the existing',
    );
  });

  it('rejects expiry and a password change racing reauthentication', async () => {
    const setup = await commands.setup(context, password, now);
    await expect(
      commands.enable(context, password, code(setup.secret, setup.expiresAt), setup.expiresAt),
    ).rejects.toThrow('Authentication failed.');
    const verify = passwords.verify.bind(passwords);
    const spy = vi.spyOn(passwords, 'verify').mockImplementationOnce(async (encoded, supplied) => {
      const matched = await verify(encoded, supplied);
      await users.withUserLock(context.userId, () =>
        users.changePassword(context.userId, new Secret('replacement-hash'), now),
      );
      return matched;
    });
    try {
      await expect(commands.setup(context, password, now)).rejects.toThrow(
        'Authentication failed.',
      );
    } finally {
      spy.mockRestore();
    }
    expect((await mfa.find(context.userId))?.activeCiphertext).toBeNull();
  });

  it('replaces recovery codes only after proof and revokes sessions before disabling MFA', async () => {
    const { enabled, active } = await enable();
    await expect(commands.regenerateRecovery(active, password, {}, now)).rejects.toThrow(
      'Authentication failed.',
    );
    const replacement = await commands.regenerateRecovery(
      active,
      password,
      { recovery: enabled.recoveryCodes[0] },
      now,
    );
    await expect(sessions.authenticate(enabled.session.token, undefined, now)).rejects.toThrow(
      'Authentication failed.',
    );
    const current = { ...active, securityVersion: 2 };
    await expect(
      commands.disable(current, password, { recovery: enabled.recoveryCodes[1] }, now),
    ).rejects.toThrow('Authentication failed.');
    await expect(
      commands.disable(
        current,
        new Secret('wrong management password'),
        { recovery: replacement.recoveryCodes[0] },
        now,
      ),
    ).rejects.toThrow('Authentication failed.');
    const disabled = await commands.disable(
      current,
      password,
      { recovery: replacement.recoveryCodes[0] },
      now,
    );
    expect(await mfa.find(context.userId)).toBeNull();
    expect((await sessions.authenticate(disabled.token, undefined, now)).user.securityVersion).toBe(
      3,
    );
    await expect(sessions.authenticate(replacement.session.token, undefined, now)).rejects.toThrow(
      'Authentication failed.',
    );
    await expect(
      sessions.login({ email: original.email, password, ...client }, now),
    ).resolves.toHaveProperty('userId', context.userId);
    const events = await fixture.app
      .get(PrismaService)
      .auditEvent.findMany({ where: { targetId: context.userId } });
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'identity.mfa_setup_requested',
        'identity.mfa_enabled',
        'identity.mfa_recovery_regenerated',
        'identity.mfa_disabled',
      ]),
    );
    expect(JSON.stringify(events)).not.toContain(password.expose());
  });

  it('rolls back activation and rotation together when auditing fails', async () => {
    const setup = await commands.setup(context, password, now);
    const stop = fixture.app
      .get(DomainEventBus)
      .subscribe(() => Promise.reject(new Error('injected audit failure')));
    try {
      await expect(commands.enable(context, password, code(setup.secret), now)).rejects.toThrow(
        'Identity storage temporarily unavailable.',
      );
    } finally {
      stop();
    }
    expect((await mfa.find(context.userId))?.activeCiphertext).toBeNull();
    await expect(sessions.authenticate(original.token, undefined, now)).resolves.toHaveProperty(
      'user',
    );
    await expect(
      commands.enable(context, password, code(setup.secret), now),
    ).resolves.toHaveProperty('recoveryCodes');
  });
});
