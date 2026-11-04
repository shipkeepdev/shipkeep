import { createEvent, Secret, SYSTEM_ACTOR } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from './domain/identity-policy';
import type { UserRecord } from './domain/identity-records';
import { PrismaIdentityStore } from './infrastructure/prisma-identity.store';

describe('identity store against PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let store: PrismaIdentityStore;
  let prisma: PrismaService;
  let user: UserRecord;
  const now = new Date();
  const tokenHash = 'a'.repeat(64);

  beforeAll(async () => {
    fixture = await integrationApp();
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
    store = new PrismaIdentityStore(fixture.app.get(PrismaUnitOfWork));
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    await prisma.user.deleteMany();
    user = {
      id: uuidv7(),
      email: 'person@example.com',
      passwordHash: new Secret('test-only-hash'),
      status: 'pending',
      emailVerifiedAt: null,
      securityVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    expect(await store.insertUser(user)).toBe(true);
    await store.insertToken({
      id: uuidv7(),
      userId: user.id,
      purpose: 'reset',
      tokenHash,
      securityVersion: 0,
      usedAt: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 1800000),
    });
  });

  it('does not abort signup transactions on a duplicate normalized email', async () => {
    await store.transaction(async () => {
      expect(await store.insertUser({ ...user, id: uuidv7(), email: 'PERSON@example.com' })).toBe(
        false,
      );
      expect((await store.findUserByEmail('PERSON@example.com'))?.id).toBe(user.id);
    });
    expect(JSON.stringify(await store.findUser(user.id))).not.toContain('test-only-hash');
  });

  it('serializes account mutations and revokes sessions and reset credentials atomically', async () => {
    await store.insertSession(session());
    await Promise.all(
      Array.from({ length: 3 }, () =>
        store.withUserLock(user.id, async (locked) => {
          await store.changePassword(locked.id, new Secret('replacement-test-hash'), now);
        }),
      ),
    );
    expect((await store.findUser(user.id))?.securityVersion).toBe(3);
    expect((await store.findSession(tokenHash))?.session.revokedAt).toEqual(now);
    expect((await store.findToken(tokenHash))?.usedAt).toEqual(now);
  });

  it('rolls back consumed credentials, account changes and audit together on failure', async () => {
    const token = await store.findToken(tokenHash);
    if (!token) throw new Error('missing token fixture');
    const bus = fixture.app.get(DomainEventBus);
    await expect(
      store.withUserLock(user.id, async () => {
        expect(await store.consumeToken(token.id, now)).toBe(true);
        await store.activateUser(user.id, now);
        await bus.publish([
          createEvent({
            type: 'identity.verified',
            actor: SYSTEM_ACTOR,
            target: { type: 'user', id: user.id },
            payload: {},
          }),
        ]);
        throw new Error('injected failure with unsafe data');
      }),
    ).rejects.toThrow('Identity storage temporarily unavailable.');
    expect((await store.findToken(tokenHash))?.usedAt).toBeNull();
    expect((await store.findUser(user.id))?.status).toBe('pending');
    expect(await prisma.auditEvent.count({ where: { targetId: user.id } })).toBe(0);
  });

  it('claims credentials only once and rejects expired or future-created tokens', async () => {
    const token = await store.findToken(tokenHash);
    if (!token) throw new Error('missing token fixture');
    expect(await store.consumeToken(token.id, new Date(now.getTime() - 1))).toBe(false);
    expect(await store.consumeToken(token.id, token.expiresAt)).toBe(false);
    const results = await Promise.all([
      store.consumeToken(token.id, now),
      store.consumeToken(token.id, now),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('does not revive idle, absolutely expired, revoked or other-user sessions', async () => {
    await store.activateUser(user.id, now);
    const record = session();
    await store.insertSession(record);
    expect(await store.touchSession(record.id, new Date(now.getTime() + SESSION_IDLE_MS))).toBe(
      false,
    );
    expect(await store.touchSession(record.id, new Date(now.getTime() + SESSION_ABSOLUTE_MS))).toBe(
      false,
    );
    expect(await store.revokeSession(uuidv7(), tokenHash, now)).toBe(false);
    expect(await store.touchSession(record.id, new Date(now.getTime() + 1000))).toBe(true);
    expect(await store.touchSession(record.id, new Date(now.getTime() + 500))).toBe(true);
    expect((await store.findSession(tokenHash))?.session.lastSeenAt).toEqual(
      new Date(now.getTime() + 1000),
    );
    expect(await store.revokeSession(user.id, tokenHash, now)).toBe(true);
    expect(await store.touchSession(record.id, new Date(now.getTime() + 2000))).toBe(false);
  });

  it('rejects sessions whose owner is disabled or whose security version changed', async () => {
    const record = session();
    await store.activateUser(user.id, now);
    await store.insertSession(record);
    await prisma.user.update({ where: { id: user.id }, data: { securityVersion: 1 } });
    expect(await store.touchSession(record.id, now)).toBe(false);
    await prisma.user.update({
      where: { id: user.id },
      data: { securityVersion: 0, status: 'disabled' },
    });
    expect(await store.touchSession(record.id, now)).toBe(false);
  });

  function session() {
    return {
      id: uuidv7(),
      userId: user.id,
      tokenHash,
      csrfHash: 'b'.repeat(64),
      securityVersion: 0,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
      revokedAt: null,
      ip: '127.0.0.1',
      userAgent: 'test',
    };
  }
});
