import { Secret, SYSTEM_ACTOR } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { EnvelopeService } from '../../platform/crypto/envelope.service';
import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

import { identityEvent } from './domain/identity-events';
import { hashToken, newTotpSecret, recoveryCodes } from './infrastructure/identity-secrets';
import { PrismaIdentityStore } from './infrastructure/prisma-identity.store';
import { PrismaMfaStore } from './infrastructure/prisma-mfa.store';

describe('MFA persistence against PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let prisma: PrismaService;
  let users: PrismaIdentityStore;
  let mfa: PrismaMfaStore;
  let peer: PrismaMfaStore;
  let id: string;
  let ciphertext: Uint8Array;
  let now: Date;
  const seed = newTotpSecret();
  const codes = recoveryCodes();
  const hashes = codes.map((code) => hashToken('recovery', code));

  beforeAll(async () => {
    fixture = await integrationApp();
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
    const database = fixture.app.get(PrismaUnitOfWork);
    users = new PrismaIdentityStore(database);
    mfa = new PrismaMfaStore(database);
    peer = new PrismaMfaStore(new PrismaUnitOfWork(prisma));
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    id = uuidv7();
    now = new Date();
    await users.insertUser({
      id,
      email: `${id}@example.com`,
      passwordHash: new Secret('test-hash'),
      status: 'active',
      emailVerifiedAt: now,
      securityVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    ciphertext = new Uint8Array(
      await fixture.app
        .get(EnvelopeService)
        .encryptFor('identity:mfa', `totp:${id}`, Buffer.from(seed.expose())),
    );
  });
  async function enable() {
    await users.withUserLock(id, async () => {
      expect(await mfa.stage(id, ciphertext, 0, now)).toBe(true);
      expect(await mfa.activate(id, 100, now)).toBe(true);
      await mfa.replaceRecovery(id, hashes, now);
    });
  }

  it('activates encrypted enrollment once and rejects replacing an active seed', async () => {
    await enable();
    expect(await mfa.activate(id, 101, now)).toBe(false);
    expect(await mfa.stage(id, new Uint8Array(64), 0, now)).toBe(false);
    const row = await mfa.find(id);
    expect(row).toMatchObject({
      pendingCiphertext: null,
      pendingExpiresAt: null,
      lastCounter: 100,
    });
    const active = row?.activeCiphertext;
    if (!active) throw new Error('missing encrypted MFA fixture');
    expect(
      (
        await fixture.app
          .get(EnvelopeService)
          .decryptFor('identity:mfa', `totp:${id}`, Buffer.from(active))
      ).toString(),
    ).toBe(seed.expose());
    const dump = JSON.stringify(
      await prisma.$queryRaw`SELECT encode(active_ciphertext, 'escape') AS seed FROM user_mfa`,
    );
    expect(dump).not.toContain(seed.expose());
    expect(JSON.stringify(await prisma.recoveryCode.findMany())).not.toContain(codes[0].expose());
  });

  it('rejects expired enrollment, changed security versions and disabled accounts', async () => {
    await mfa.stage(id, ciphertext, 0, now);
    expect(await mfa.activate(id, 100, new Date(now.getTime() + 600000))).toBe(false);
    await users.withUserLock(id, () =>
      users.changePassword(id, new Secret('replacement-hash'), now),
    );
    expect(await mfa.activate(id, 100, now)).toBe(false);
    await mfa.stage(id, ciphertext, 1, now);
    await prisma.user.update({ where: { id }, data: { status: 'disabled' } });
    expect(await mfa.activate(id, 100, now)).toBe(false);
  });

  it('claims TOTP counters and recovery codes once across connections', async () => {
    await enable();
    const counters = await Promise.all(
      [mfa, peer].map((store) => store.claimCounter(id, 101, now)),
    );
    expect(counters.filter(Boolean)).toHaveLength(1);
    expect(await mfa.claimCounter(id, 100, now)).toBe(false);
    const recovery = await Promise.all(
      [mfa, peer].map((store) => store.claimRecovery(id, hashes[0], now)),
    );
    expect(recovery.filter(Boolean)).toHaveLength(1);
    expect(await mfa.claimRecovery(uuidv7(), hashes[1], now)).toBe(false);
    await users.withUserLock(id, () => mfa.remove(id));
    expect(await mfa.find(id)).toBeNull();
    expect(await prisma.recoveryCode.count({ where: { userId: id } })).toBe(0);
  });

  it('rolls back enrollment and consumed recovery proof if the audit fails', async () => {
    await enable();
    const bus = fixture.app.get(DomainEventBus);
    const stop = bus.subscribe(() => Promise.reject(new Error('injected audit failure')));
    try {
      await expect(
        users.withUserLock(id, async () => {
          expect(await mfa.claimRecovery(id, hashes[0], now)).toBe(true);
          await mfa.remove(id);
          await bus.publish([identityEvent('mfa_disabled', id, SYSTEM_ACTOR, now)]);
        }),
      ).rejects.toThrow('Identity storage temporarily unavailable.');
    } finally {
      stop();
    }
    expect((await mfa.find(id))?.activeCiphertext).not.toBeNull();
    expect(await mfa.claimRecovery(id, hashes[0], now)).toBe(true);
    expect(await prisma.recoveryCode.count({ where: { userId: id } })).toBe(10);
    await expect(mfa.replaceRecovery(id, ['bad-hash'], now)).rejects.toThrow('Ten unique');
    expect(await prisma.recoveryCode.count({ where: { userId: id } })).toBe(10);
  });
});
