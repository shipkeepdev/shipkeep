import { ConflictError, InvalidInputError, NotFoundError, Secret } from '@shipkeep/domain';

import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

import { AccountCommands } from './application/account-commands';
import type { IdentityMailer } from './application/identity-ports';
import { MfaProof } from './application/mfa-proof';
import { OperatorAccountCommands } from './application/operator-account-commands';
import { SessionCommands } from './application/session-commands';
import { hashToken, issueToken, matchesTokenHash } from './infrastructure/identity-secrets';
import { PasswordHasher } from './infrastructure/password-hasher';
import { PrismaIdentityStore } from './infrastructure/prisma-identity.store';

/** ADR 0020: accounts created and recovered on the server, for an installation without email. */
describe('accounts created on the server, against PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let prisma: PrismaService;
  let operator: OperatorAccountCommands;
  let sessions: SessionCommands;
  let withMail: AccountCommands;
  let withoutMail: AccountCommands;
  const sent: Parameters<IdentityMailer['send']>[0][] = [];
  const first = new Secret('first passphrase of the owner');
  const second = new Secret('second passphrase of the owner');
  const login = (password: Secret, email = 'owner@example.com') => ({
    email,
    password,
    ip: '127.0.0.1',
    userAgent: 'test',
  });
  const events = async (userId: string) =>
    (await prisma.auditEvent.findMany({ where: { targetId: userId }, orderBy: { id: 'asc' } })).map(
      (event) => [event.action, event.actorKind],
    );

  beforeAll(async () => {
    fixture = await integrationApp();
    prisma = fixture.app.get(PrismaService);
    const store = new PrismaIdentityStore(fixture.app.get(PrismaUnitOfWork));
    const passwords = new PasswordHasher();
    const bus = fixture.app.get(DomainEventBus);
    const secrets = { issue: issueToken, hash: hashToken, matches: matchesTokenHash };
    const mailer = (enabled: boolean): IdentityMailer => ({
      enabled,
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    });
    operator = new OperatorAccountCommands(store, passwords, bus);
    sessions = new SessionCommands(store, passwords, secrets, bus, fixture.app.get(MfaProof));
    withMail = new AccountCommands(store, passwords, secrets, mailer(true), bus);
    withoutMail = new AccountCommands(store, passwords, secrets, mailer(false), bus);
  });
  afterAll(async () => {
    await fixture.close();
  });
  beforeEach(async () => {
    await prisma.user.deleteMany();
    sent.length = 0;
  });

  it('creates an account that signs in at once, and sends nothing', async () => {
    const created = await operator.create('  Owner@Example.com ', first);
    expect(created.email).toBe('owner@example.com');

    const grant = await sessions.login(login(first));
    expect(grant.userId).toBe(created.id);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored).toMatchObject({ status: 'active', securityVersion: 0 });
    // Confirmed by the operator of the installation instead of by a mailbox.
    expect(stored.emailVerifiedAt).not.toBeNull();
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(sent).toEqual([]);
    expect(await prisma.identityToken.count()).toBe(0);
    expect((await events(created.id))[0]).toEqual(['identity.created_by_operator', 'system']);
  });

  it('refuses an address that already has an account, and leaves that account as it is', async () => {
    await operator.create('owner@example.com', first);
    const refusal = await operator
      .create('OWNER@example.com', second)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ConflictError);
    expect(refusal).toMatchObject({ code: 'account_exists' });
    await expect(sessions.login(login(first))).resolves.toHaveProperty('userId');
    await expect(sessions.login(login(second))).rejects.toThrow('Authentication failed.');
    expect(await prisma.user.count()).toBe(1);
  });

  it('refuses a short password and what is not an address, and stores nothing', async () => {
    const recorded = () =>
      prisma.auditEvent.count({ where: { action: 'identity.created_by_operator' } });
    const before = await recorded();
    await expect(operator.create('owner@example.com', new Secret('too short'))).rejects.toThrow(
      InvalidInputError,
    );
    for (const address of ['owner', 'owner@', '@example.com', 'owner@example', 'a b@example.com'])
      await expect(operator.create(address, first), address).rejects.toThrow(InvalidInputError);
    expect(await prisma.user.count()).toBe(0);
    expect(await recorded()).toBe(before);
  });

  it('resets a password: the old one, the open sessions and the pending links stop', async () => {
    const created = await operator.create('owner@example.com', first);
    const before = await sessions.login(login(first));
    await withMail.requestEmail('owner@example.com', 'reset');
    const link = sent.find((mail) => mail.purpose === 'reset');
    if (!link) throw new Error('missing reset link fixture');

    await operator.resetPassword('Owner@example.com', second);

    await expect(sessions.login(login(first))).rejects.toThrow('Authentication failed.');
    await expect(sessions.authenticate(before.token)).rejects.toThrow();
    await expect(withMail.resetPassword(link.token, first)).rejects.toThrow(
      'Authentication failed.',
    );
    await expect(sessions.login(login(second))).resolves.toHaveProperty('userId', created.id);
    const recorded = (await events(created.id)).map(([action]) => action);
    expect(recorded).toContain('identity.password_reset_by_operator');
    expect(recorded).not.toContain('identity.activated_by_operator');
  });

  it('activates an account that never confirmed its address when its password is reset', async () => {
    await withMail.register('owner@example.com', first);
    await expect(sessions.login(login(first))).rejects.toThrow('Authentication failed.');
    await operator.resetPassword('owner@example.com', second);
    const grant = await sessions.login(login(second));
    // The audit log says that the operator made this account usable, not only that a password
    // changed. An account that was already active gets the reset event alone.
    expect((await events(grant.userId)).map(([action]) => action)).toEqual([
      'identity.registered',
      'identity.activated_by_operator',
      'identity.password_reset_by_operator',
      'identity.logged_in',
    ]);
    // The confirmation link that was sent no longer activates anything.
    const link = sent.find((mail) => mail.purpose === 'verify');
    if (!link) throw new Error('missing verification fixture');
    await expect(withMail.verifyEmail(link.token, first)).rejects.toThrow('Authentication failed.');
  });

  it('refuses to reset an unknown or a disabled account, and a short password', async () => {
    await expect(operator.resetPassword('nobody@example.com', second)).rejects.toThrow(
      NotFoundError,
    );
    const created = await operator.create('owner@example.com', first);
    await expect(
      operator.resetPassword('owner@example.com', new Secret('too short')),
    ).rejects.toThrow(InvalidInputError);
    await prisma.user.update({ where: { id: created.id }, data: { status: 'disabled' } });
    await expect(operator.resetPassword('owner@example.com', second)).rejects.toMatchObject({
      code: 'account_disabled',
    });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored).toMatchObject({ status: 'disabled', securityVersion: 0 });
  });

  describe('when the installation sends no email', () => {
    it('refuses sign-up for everyone, and stores and sends nothing', async () => {
      await expect(withoutMail.register('person@example.com', first)).rejects.toMatchObject({
        constructor: ConflictError,
        code: 'email_not_configured',
      });
      expect(await prisma.user.count()).toBe(0);
      expect(sent).toEqual([]);
    });

    it('refuses confirmation and reset requests alike for a known and an unknown address', async () => {
      await operator.create('owner@example.com', first);
      for (const address of ['owner@example.com', 'nobody@example.com'])
        for (const purpose of ['verify', 'reset'] as const)
          await expect(
            withoutMail.requestEmail(address, purpose),
            `${purpose} ${address}`,
          ).rejects.toMatchObject({ code: 'email_not_configured' });
      expect(sent).toEqual([]);
      expect(await prisma.identityToken.count()).toBe(0);
    });
  });
});
