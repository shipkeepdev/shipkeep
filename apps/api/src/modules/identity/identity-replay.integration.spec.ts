import { Secret, SYSTEM_ACTOR } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { EnvelopeService } from '../../platform/crypto/envelope.service';
import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

import { identityEvent } from './domain/identity-events';
import { PrivateIdentityReplay } from './infrastructure/private-identity-replay';

describe('private identity retries against PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let database: PrismaUnitOfWork;
  let prisma: PrismaService;
  let replay: PrivateIdentityReplay;
  let peer: PrivateIdentityReplay;
  const input = new Secret('{"password":"retry-test-passphrase"}');
  const output = new Secret('{"cookie":"test-private-session"}');
  beforeAll(async () => {
    fixture = await integrationApp();
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
    database = fixture.app.get(PrismaUnitOfWork);
    const envelope = fixture.app.get(EnvelopeService);
    replay = new PrivateIdentityReplay(database, envelope);
    peer = new PrivateIdentityReplay(new PrismaUnitOfWork(prisma), envelope);
  });
  afterAll(async () => {
    await close?.();
  });

  it('runs concurrent identical requests once and encrypts both the request and response', async () => {
    const key = uuidv7();
    const operation = vi.fn(() => Promise.resolve(output));
    const results = await Promise.all(
      [replay, peer].map((service) => service.execute('auth/login', key, input, operation)),
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    for (const result of results) expect(result.response.expose()).toBe(output.expose());
    const dump = JSON.stringify(
      await prisma.$queryRaw`SELECT key_hash, encode(ciphertext, 'escape') AS data FROM identity_replays`,
    );
    for (const secret of [key, 'retry-test-passphrase', 'test-private-session'])
      expect(dump).not.toContain(secret);
  });

  it('binds retries to the route and complete request, while expiry permits a new operation', async () => {
    const key = uuidv7();
    const now = new Date();
    const operation = vi.fn(() => Promise.resolve(output));
    await replay.execute('auth/login', key, input, operation, now);
    await expect(
      peer.execute('auth/login', key, new Secret('changed'), operation, now),
    ).rejects.toThrow('different request');
    expect(operation).toHaveBeenCalledTimes(1);
    await peer.execute('auth/register', key, input, operation, now);
    await peer.execute('auth/login', key, input, operation, new Date(now.getTime() + 300000));
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('rolls back the command and audit if the retry result cannot be persisted', async () => {
    const id = uuidv7();
    const key = uuidv7();
    const run = () =>
      replay.execute('auth/register', key, input, async () => {
        await database.client.user.create({
          data: {
            id,
            email: `${id}@example.com`,
            passwordHash: 'test-hash',
            status: 'pending',
            securityVersion: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
        await fixture.app
          .get(DomainEventBus)
          .publish([identityEvent('registered', id, SYSTEM_ACTOR, new Date())]);
        return output;
      });
    await prisma.$executeRaw`ALTER TABLE identity_replays ADD CONSTRAINT test_reject_replay CHECK (false) NOT VALID`;
    try {
      await expect(run()).rejects.toThrow('Request retry storage temporarily unavailable.');
    } finally {
      await prisma.$executeRaw`ALTER TABLE identity_replays DROP CONSTRAINT test_reject_replay`;
    }
    expect(await prisma.user.count({ where: { id } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { targetId: id } })).toBe(0);
    await run();
    expect(await prisma.user.count({ where: { id } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { targetId: id } })).toBe(1);
  });

  it('fails closed on altered ciphertext and invalid keys without calling the command', async () => {
    const key = uuidv7();
    await replay.execute('auth/login', key, input, () => Promise.resolve(output));
    await prisma.identityReplay.updateMany({ data: { ciphertext: new Uint8Array(64) } });
    const operation = vi.fn(() => Promise.resolve(output));
    await expect(replay.execute('auth/login', key, input, operation)).rejects.toThrow(
      'Request retry storage temporarily unavailable.',
    );
    await expect(replay.execute('auth/login', 'invalid-key', input, operation)).rejects.toThrow(
      'UUID',
    );
    expect(operation).not.toHaveBeenCalled();
  });
});
