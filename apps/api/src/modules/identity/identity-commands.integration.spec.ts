import { Secret } from '@shipkeep/domain';

import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

import { AccountCommands } from './application/account-commands';
import type { IdentityMailer } from './application/identity-ports';
import { SessionCommands } from './application/session-commands';
import { MfaProof } from './application/mfa-proof';
import { hashToken, issueToken, matchesTokenHash } from './infrastructure/identity-secrets';
import { PasswordHasher } from './infrastructure/password-hasher';
import { PrismaIdentityStore } from './infrastructure/prisma-identity.store';

describe('identity commands against PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let accounts: AccountCommands;
  let sessions: SessionCommands;
  let store: PrismaIdentityStore;
  let prisma: PrismaService;
  let passwords: PasswordHasher;
  const sent: Parameters<IdentityMailer['send']>[0][] = [];
  const password = new Secret('correct horse test password');
  const login = () => ({
    email: 'person@example.com',
    password,
    ip: '127.0.0.1',
    userAgent: 'test',
  });

  beforeAll(async () => {
    fixture = await integrationApp();
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
    store = new PrismaIdentityStore(fixture.app.get(PrismaUnitOfWork));
    passwords = new PasswordHasher();
    const bus = fixture.app.get(DomainEventBus);
    const secrets = { issue: issueToken, hash: hashToken, matches: matchesTokenHash };
    accounts = new AccountCommands(
      store,
      passwords,
      secrets,
      {
        send: (message) => {
          sent.push(message);
          return Promise.resolve();
        },
      },
      bus,
    );
    sessions = new SessionCommands(store, passwords, secrets, bus, fixture.app.get(MfaProof));
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    await prisma.user.deleteMany();
    sent.length = 0;
    await accounts.register('person@example.com', password);
  });

  async function verify() {
    const message = sent.find((mail) => mail.purpose === 'verify');
    if (!message) throw new Error('missing verification fixture');
    await accounts.verifyEmail(message.token, password);
    return message;
  }

  it('requires mailbox ownership and consumes verification once', async () => {
    await expect(sessions.login(login())).rejects.toThrow('Authentication failed.');
    const message = await verify();
    await expect(accounts.verifyEmail(message.token, password)).rejects.toThrow(
      'Authentication failed.',
    );
    const grant = await sessions.login(login());
    expect((await sessions.authenticate(grant.token)).user.email).toBe('person@example.com');
    expect(await prisma.auditEvent.count({ where: { targetId: grant.userId } })).toBe(3);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: grant.userId } });
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(await prisma.userSession.findMany())).not.toContain(grant.token.expose());
  });

  it('keeps existing credentials when signup is retried', async () => {
    await accounts.register('PERSON@example.com', new Secret('different password for duplicate'));
    expect(sent).toHaveLength(1);
    await verify();
    await expect(sessions.login(login())).resolves.toHaveProperty('userId');
    await expect(
      sessions.login({ ...login(), password: new Secret('different password for duplicate') }),
    ).rejects.toThrow('Authentication failed.');
  });

  it('stops account pre-hijacking: the mailbox owner claims the address through reset', async () => {
    // beforeEach plays the attacker: person@example.com was registered with the attacker's password.
    const attackerLink = sent[0];
    const owner = new Secret('mailbox owner chosen passphrase');
    // The owner clicks the link but cannot activate a password they never chose.
    await expect(accounts.verifyEmail(attackerLink.token, owner)).rejects.toThrow(
      'Authentication failed.',
    );
    await accounts.requestEmail('person@example.com', 'reset');
    const reset = sent.find((mail) => mail.purpose === 'reset');
    if (!reset) throw new Error('pending accounts must receive reset links');
    await accounts.resetPassword(reset.token, owner);
    const claimed = await prisma.user.findUniqueOrThrow({ where: { email: 'person@example.com' } });
    expect(claimed.status).toBe('active');
    expect(claimed.emailVerifiedAt).not.toBeNull();
    // The attacker's password and verification link are both dead.
    await expect(sessions.login(login())).rejects.toThrow('Authentication failed.');
    await expect(accounts.verifyEmail(attackerLink.token, password)).rejects.toThrow(
      'Authentication failed.',
    );
    await expect(sessions.login({ ...login(), password: owner })).resolves.toHaveProperty('userId');
    expect(
      (
        await prisma.auditEvent.findMany({
          where: { targetId: claimed.id },
          orderBy: { id: 'asc' },
        })
      )
        .map((row) => row.action)
        .slice(-3),
    ).toEqual(['identity.email_verified', 'identity.password_reset', 'identity.logged_in']);
  });

  it('does not consume the verification link when the password is wrong', async () => {
    const message = sent[0];
    await expect(
      accounts.verifyEmail(message.token, new Secret('not the registered password')),
    ).rejects.toThrow('Authentication failed.');
    await verify();
  });

  it('rejects expired and wrong-purpose links without consuming a valid verification link', async () => {
    const message = sent[0];
    await expect(accounts.verifyEmail(message.token, password, message.expiresAt)).rejects.toThrow(
      'Authentication failed.',
    );
    await expect(accounts.resetPassword(message.token, password)).rejects.toThrow(
      'Authentication failed.',
    );
    await verify();
  });

  it('does not grant a session or consume verification when auditing fails', async () => {
    const bus = fixture.app.get(DomainEventBus);
    let stop = bus.subscribe(() => Promise.reject(new Error('injected audit failure')));
    try {
      await expect(verify()).rejects.toThrow('Identity storage temporarily unavailable.');
    } finally {
      stop();
    }
    await verify();
    stop = bus.subscribe(() => Promise.reject(new Error('injected audit failure')));
    try {
      await expect(sessions.login(login())).rejects.toThrow(
        'Identity storage temporarily unavailable.',
      );
      expect(await prisma.userSession.count()).toBe(0);
    } finally {
      stop();
    }
  });

  it('rotates the current session on login and binds CSRF to its session', async () => {
    await verify();
    const first = await sessions.login(login());
    const second = await sessions.login({ ...login(), previous: first.token });
    await expect(sessions.authenticate(first.token)).rejects.toThrow('Authentication failed.');
    await expect(sessions.authenticate(second.token, first.csrf)).rejects.toThrow(
      'Authentication failed.',
    );
    await expect(sessions.authenticate(second.token, second.csrf)).resolves.toHaveProperty('user');
    await sessions.logout(second.userId, second.token);
    await expect(sessions.authenticate(second.token)).rejects.toThrow('Authentication failed.');
    await sessions.logout(second.userId, second.token);
    expect(
      await prisma.auditEvent.count({
        where: { targetId: second.userId, action: 'identity.logged_out' },
      }),
    ).toBe(1);
  });

  it('resets once and invalidates all older sessions and reset links', async () => {
    await verify();
    const grant = await sessions.login(login());
    await accounts.requestEmail('person@example.com', 'reset');
    await accounts.requestEmail('person@example.com', 'reset');
    const links = sent.filter((mail) => mail.purpose === 'reset');
    const replacement = new Secret('a brand new test password');
    const results = await Promise.allSettled(
      links.map((link) => accounts.resetPassword(link.token, replacement)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(sessions.authenticate(grant.token)).rejects.toThrow('Authentication failed.');
    await expect(sessions.login(login())).rejects.toThrow('Authentication failed.');
    await expect(sessions.login({ ...login(), password: replacement })).resolves.toHaveProperty(
      'userId',
    );
  });

  it('rejects login when the password changes between proof and session creation', async () => {
    await verify();
    const verifyPassword = passwords.verify.bind(passwords);
    const spy = vi.spyOn(passwords, 'verify').mockImplementationOnce(async (encoded, supplied) => {
      const matched = await verifyPassword(encoded, supplied);
      const user = await store.findUserByEmail('person@example.com');
      if (!user) throw new Error('missing user fixture');
      await store.withUserLock(user.id, () =>
        store.changePassword(user.id, new Secret('changed-test-hash'), new Date()),
      );
      return matched;
    });
    try {
      await expect(sessions.login(login())).rejects.toThrow('Authentication failed.');
      expect(await prisma.userSession.count()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns the same rejection for unknown, disabled and incorrect-password accounts', async () => {
    await verify();
    await expect(sessions.login({ ...login(), email: 'missing@example.com' })).rejects.toThrow(
      'Authentication failed.',
    );
    await expect(
      sessions.login({ ...login(), password: new Secret('incorrect password value') }),
    ).rejects.toThrow('Authentication failed.');
    await prisma.user.updateMany({ data: { status: 'disabled' } });
    await expect(sessions.login(login())).rejects.toThrow('Authentication failed.');
  });
});
