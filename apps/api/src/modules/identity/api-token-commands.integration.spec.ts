import { Secret } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

import { ApiTokenCommands } from './application/api-token-commands';
import {
  API_TOKEN_AUTHORITY,
  AccountTokenAuthority,
  type ApiTokenAuthority,
} from './application/api-token-authority';
import { PASSWORD_HASHER, type PasswordHashing } from './application/identity-ports';
import type { SecurityContext } from './application/mfa-commands';
import { MFA_CRYPTO, type MfaCrypto } from './application/mfa-crypto';
import { MFA_STORE, type MfaStore } from './application/mfa-store';
import { PrismaIdentityStore } from './infrastructure/prisma-identity.store';

describe('audited API token commands', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  let users: PrismaIdentityStore;
  let commands: ApiTokenCommands;
  let passwords: PasswordHashing;
  let context: SecurityContext;
  let now: Date;
  let allowTenant = false;
  const password = new Secret('correct horse API token password');
  const organizationId = uuidv7();
  const authority: ApiTokenAuthority = {
    allows: (_userId, permission, target) =>
      Promise.resolve(
        permission === 'profile.read'
          ? new AccountTokenAuthority().allows(_userId, permission, target)
          : allowTenant,
      ),
  };
  const input = () => ({
    name: 'Automation',
    scopes: [{ permission: 'profile.read' }],
    expiresAt: new Date(now.getTime() + 3600000),
  });
  beforeAll(async () => {
    fixture = await integrationApp([{ token: API_TOKEN_AUTHORITY, value: authority }]);
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
    users = new PrismaIdentityStore(fixture.app.get(PrismaUnitOfWork));
    commands = fixture.app.get(ApiTokenCommands);
    passwords = fixture.app.get<PasswordHashing>(PASSWORD_HASHER);
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    now = new Date();
    allowTenant = false;
    const id = uuidv7();
    context = { userId: id, securityVersion: 0, ip: '127.0.0.1', userAgent: 'API token fixture' };
    await users.insertUser({
      id,
      email: `${id}@example.com`,
      passwordHash: await passwords.hash(password),
      status: 'active',
      emailVerifiedAt: now,
      securityVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
  });

  it('returns the secret only on creation and audits owner-bound idempotent revocation', async () => {
    const grant = await commands.create(context, input(), password, {}, now);
    expect(grant.token.expose()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(grant)).not.toContain(grant.token.expose());
    const page = await commands.list(context, undefined, now);
    expect(page).toHaveLength(1);
    expect(page[0]).toMatchObject({ id: grant.metadata.id, status: 'active' });
    expect(JSON.stringify(page)).not.toMatch(/tokenHash|securityVersion|userId/);
    expect(await commands.list(context, grant.metadata.id, now)).toEqual([]);
    const other = { ...context, userId: uuidv7() };
    await users.insertUser({
      id: other.userId,
      email: `${other.userId}@example.com`,
      passwordHash: await passwords.hash(password),
      status: 'active',
      emailVerifiedAt: now,
      securityVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    expect(await commands.list(other, undefined, now)).toEqual([]);
    await expect(commands.revoke(other, grant.metadata.id, password, {}, now)).rejects.toThrow(
      'api_token not found',
    );
    await expect(commands.revoke(context, uuidv7(), password, {}, now)).rejects.toThrow(
      'api_token not found',
    );
    await commands.revoke(context, grant.metadata.id, password, {}, now);
    await commands.revoke(context, grant.metadata.id, password, {}, now);
    expect((await commands.list(context, undefined, now))[0]).toHaveProperty('status', 'revoked');
    const events = await prisma.auditEvent.findMany({ where: { targetId: grant.metadata.id } });
    expect(events.map((event) => event.action).sort()).toEqual([
      'identity.api_token_created',
      'identity.api_token_revoked',
    ]);
    expect(JSON.stringify(events)).not.toContain(grant.token.expose());
  });

  it('requires password, live version and owner authority before granting scopes', async () => {
    await expect(
      commands.create(context, input(), new Secret('wrong password'), {}, now),
    ).rejects.toThrow('Authentication failed.');
    const tenant = { ...input(), scopes: [{ permission: 'deploy.run', organizationId }] };
    await expect(commands.create(context, tenant, password, {}, now)).rejects.toThrow(
      'Permission denied.',
    );
    expect(
      new AccountTokenAuthority().allows(context.userId, 'deploy.run', { organizationId }),
    ).toBe(false);
    expect(
      new AccountTokenAuthority().allows(context.userId, 'profile.read', { organizationId }),
    ).toBe(false);
    allowTenant = true;
    await commands.create(context, tenant, password, {}, now);
    const verify = passwords.verify.bind(passwords);
    const spy = vi.spyOn(passwords, 'verify').mockImplementationOnce(async (hash, supplied) => {
      const matched = await verify(hash, supplied);
      await users.withUserLock(context.userId, () =>
        users.advanceSecurityVersion(context.userId, now),
      );
      return matched;
    });
    try {
      await expect(commands.create(context, input(), password, {}, now)).rejects.toThrow(
        'Authentication failed.',
      );
    } finally {
      spy.mockRestore();
    }
    await expect(commands.list(context, undefined, now)).rejects.toThrow('Authentication failed.');
    expect(
      (await commands.list({ ...context, securityVersion: 1 }, undefined, now))[0],
    ).toHaveProperty('status', 'invalidated');
  });

  it('serializes concurrent creation at the active-token limit', async () => {
    const grant = await commands.create(context, input(), password, {}, now);
    const row = await prisma.apiToken.findUniqueOrThrow({ where: { id: grant.metadata.id } });
    await prisma.apiToken.createMany({
      data: Array.from({ length: 48 }, (_, index) => ({
        ...row,
        scopes: input().scopes,
        id: uuidv7(),
        tokenHash: index.toString(16).padStart(64, '0'),
      })),
    });
    const results = await Promise.allSettled(
      [0, 1].map(() => commands.create(context, input(), password, {}, now)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.apiToken.count({ where: { userId: context.userId } })).toBe(50);
    expect((await commands.list(context, undefined, input().expiresAt))[0]).toHaveProperty(
      'status',
      'expired',
    );
  });

  it('requires MFA and rolls proof consumption and token creation back on audit failure', async () => {
    const mfa = fixture.app.get<MfaStore>(MFA_STORE);
    const crypto = fixture.app.get<MfaCrypto>(MFA_CRYPTO);
    const codes = crypto.recoveryCodes();
    await users.withUserLock(context.userId, async () => {
      await mfa.stage(context.userId, await crypto.encrypt(context.userId, crypto.seed()), 0, now);
      await mfa.activate(context.userId, 100, now);
      await mfa.replaceRecovery(
        context.userId,
        codes.map((code) => crypto.recoveryHash(code)),
        now,
      );
    });
    await expect(commands.create(context, input(), password, {}, now)).rejects.toThrow(
      'Authentication failed.',
    );
    const stop = fixture.app
      .get(DomainEventBus)
      .subscribe((event) =>
        event.type === 'identity.api_token_created'
          ? Promise.reject(new Error('injected audit failure'))
          : Promise.resolve(),
      );
    try {
      await expect(
        commands.create(context, input(), password, { recovery: codes[0] }, now),
      ).rejects.toThrow('Identity storage temporarily unavailable.');
    } finally {
      stop();
    }
    expect(await prisma.apiToken.count({ where: { userId: context.userId } })).toBe(0);
    expect(await mfa.remainingRecovery(context.userId)).toBe(10);
    const grant = await commands.create(context, input(), password, { recovery: codes[0] }, now);
    await expect(commands.revoke(context, grant.metadata.id, password, {}, now)).rejects.toThrow(
      'Authentication failed.',
    );
    const stopRevoke = fixture.app
      .get(DomainEventBus)
      .subscribe((event) =>
        event.type === 'identity.api_token_revoked'
          ? Promise.reject(new Error('injected audit failure'))
          : Promise.resolve(),
      );
    try {
      await expect(
        commands.revoke(context, grant.metadata.id, password, { recovery: codes[1] }, now),
      ).rejects.toThrow('Identity storage temporarily unavailable.');
    } finally {
      stopRevoke();
    }
    expect((await commands.list(context, undefined, now))[0]).toHaveProperty('status', 'active');
    expect(await mfa.remainingRecovery(context.userId)).toBe(9);
    await commands.revoke(context, grant.metadata.id, password, { recovery: codes[1] }, now);
    expect(await mfa.remainingRecovery(context.userId)).toBe(8);
  });
});
