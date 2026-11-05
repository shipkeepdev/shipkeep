import { Secret } from '@shipkeep/domain';
import * as OTPAuth from 'otpauth';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

import { AccountCommands } from './application/account-commands';
import {
  IDENTITY_MAILER,
  type IdentityMailer,
  PASSWORD_HASHER,
  type PasswordHashing,
} from './application/identity-ports';
import { MFA_CRYPTO, type MfaCrypto } from './application/mfa-crypto';
import { MFA_STORE, type MfaStore } from './application/mfa-store';
import { SessionCommands } from './application/session-commands';
import { PrismaIdentityStore } from './infrastructure/prisma-identity.store';

describe('second-factor login and session rotation', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let users: PrismaIdentityStore;
  let sessions: SessionCommands;
  let crypto: MfaCrypto;
  let mfa: MfaStore;
  let id: string;
  let email: string;
  let now: Date;
  let code: Secret;
  let recovery: Secret[];
  const sent: Parameters<IdentityMailer['send']>[0][] = [];
  const password = new Secret('correct horse MFA test password');
  const context = { ip: '127.0.0.1', userAgent: 'MFA integration fixture' };
  const input = () => ({ email, password, ...context });

  beforeAll(async () => {
    fixture = await integrationApp([
      {
        token: IDENTITY_MAILER,
        value: {
          send: (message: Parameters<IdentityMailer['send']>[0]) => {
            sent.push(message);
            return Promise.resolve();
          },
        },
      },
    ]);
    close = fixture.close;
    users = new PrismaIdentityStore(fixture.app.get(PrismaUnitOfWork));
    sessions = fixture.app.get(SessionCommands);
    crypto = fixture.app.get<MfaCrypto>(MFA_CRYPTO);
    mfa = fixture.app.get<MfaStore>(MFA_STORE);
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    id = uuidv7();
    email = `${id}@example.com`;
    now = new Date();
    sent.length = 0;
    await users.insertUser({
      id,
      email,
      passwordHash: await fixture.app.get<PasswordHashing>(PASSWORD_HASHER).hash(password),
      status: 'active',
      emailVerifiedAt: now,
      securityVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const secret = crypto.seed();
    code = new Secret(
      new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(secret.expose()),
        digits: 6,
        period: 30,
        algorithm: 'SHA1',
      }).generate({ timestamp: now.getTime() }),
    );
    recovery = crypto.recoveryCodes();
    await users.withUserLock(id, async () => {
      await mfa.stage(id, await crypto.encrypt(id, secret), 0, now);
      expect(await mfa.activate(id, Math.floor(now.getTime() / 30000) - 1, now)).toBe(true);
      await mfa.replaceRecovery(
        id,
        recovery.map((value) => crypto.recoveryHash(value)),
        now,
      );
    });
  });

  it('requires one valid factor before granting a session and rejects replayed counters', async () => {
    await expect(sessions.login(input(), now)).rejects.toThrow('Authentication failed.');
    await expect(
      sessions.login({ ...input(), secondFactor: { totp: new Secret('invalid') } }, now),
    ).rejects.toThrow('Authentication failed.');
    await expect(
      sessions.login({ ...input(), secondFactor: { totp: code, recovery: recovery[0] } }, now),
    ).rejects.toThrow('Authentication failed.');
    const grant = await sessions.login({ ...input(), secondFactor: { totp: code } }, now);
    expect((await sessions.authenticate(grant.token, grant.csrf, now)).user.id).toBe(id);
    await expect(sessions.login({ ...input(), secondFactor: { totp: code } }, now)).rejects.toThrow(
      'Authentication failed.',
    );
  });

  it('grants only one login for concurrent use of either factor', async () => {
    for (const secondFactor of [{ totp: code }, { recovery: recovery[0] }]) {
      const results = await Promise.allSettled(
        [0, 1].map(() => sessions.login({ ...input(), secondFactor }, now)),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    }
  });

  it('preserves the TOTP proof when session auditing fails', async () => {
    const stop = fixture.app
      .get(DomainEventBus)
      .subscribe(() => Promise.reject(new Error('injected audit failure')));
    try {
      await expect(
        sessions.login({ ...input(), secondFactor: { totp: code } }, now),
      ).rejects.toThrow('Identity storage temporarily unavailable.');
    } finally {
      stop();
    }
    await expect(
      sessions.login({ ...input(), secondFactor: { totp: code } }, now),
    ).resolves.toHaveProperty('userId', id);
  });

  it('keeps MFA enabled after a password reset and revokes the previous session', async () => {
    const prior = await sessions.login({ ...input(), secondFactor: { totp: code } }, now);
    const accounts = fixture.app.get(AccountCommands);
    await accounts.requestEmail(email, 'reset', now);
    const token = sent.at(0)?.token;
    if (!token) throw new Error('missing reset fixture');
    const replacement = new Secret('replacement MFA test password');
    await accounts.resetPassword(token, replacement, now);
    await expect(sessions.authenticate(prior.token, undefined, now)).rejects.toThrow(
      'Authentication failed.',
    );
    await expect(sessions.login({ ...input(), password: replacement }, now)).rejects.toThrow(
      'Authentication failed.',
    );
    await expect(
      sessions.login(
        { ...input(), password: replacement, secondFactor: { recovery: recovery[0] } },
        now,
      ),
    ).resolves.toHaveProperty('userId', id);
  });

  it('rotates all sessions and reset links atomically and rejects a stale security context', async () => {
    const prior = await sessions.login({ ...input(), secondFactor: { totp: code } }, now);
    const accounts = fixture.app.get(AccountCommands);
    await accounts.requestEmail(email, 'reset', now);
    const stop = fixture.app
      .get(DomainEventBus)
      .subscribe(() => Promise.reject(new Error('injected audit failure')));
    try {
      await expect(sessions.rotateAuthenticated(id, 0, context, now)).rejects.toThrow(
        'Identity storage temporarily unavailable.',
      );
    } finally {
      stop();
    }
    await expect(sessions.authenticate(prior.token, undefined, now)).resolves.toHaveProperty(
      'user',
    );
    const rotated = await sessions.rotateAuthenticated(id, 0, context, now);
    expect(
      (await sessions.authenticate(rotated.token, rotated.csrf, now)).user.securityVersion,
    ).toBe(1);
    await expect(sessions.authenticate(prior.token, undefined, now)).rejects.toThrow(
      'Authentication failed.',
    );
    await expect(sessions.rotateAuthenticated(id, 0, context, now)).rejects.toThrow(
      'Authentication failed.',
    );
    const token = sent.at(0)?.token;
    if (!token) throw new Error('missing reset fixture');
    await expect(accounts.resetPassword(token, password, now)).rejects.toThrow(
      'Authentication failed.',
    );
  });
});
