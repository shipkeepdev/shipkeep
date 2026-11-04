import { PrismaService } from '../../platform/prisma/prisma.service';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { integrationApp } from '../../testing/integration-app';

import { PrismaIdentityThrottle } from './infrastructure/prisma-identity-throttle';

describe('shared authentication throttling', () => {
  let fixture: Awaited<ReturnType<typeof integrationApp>>;
  let close: (() => Promise<void>) | undefined;
  let first: PrismaIdentityThrottle;
  let second: PrismaIdentityThrottle;
  let prisma: PrismaService;
  const now = new Date();
  const ip = '192.0.2.1';
  const subject = 'person@example.com';

  beforeAll(async () => {
    fixture = await integrationApp();
    close = fixture.close;
    prisma = fixture.app.get(PrismaService);
    first = new PrismaIdentityThrottle(fixture.app.get(PrismaUnitOfWork));
    second = new PrismaIdentityThrottle(new PrismaUnitOfWork(prisma));
  });
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    await prisma.identityThrottle.deleteMany();
  });

  it('admits one overlapping password proof per account across instances', async () => {
    const decisions = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? first : second).acquire('login', `192.0.2.${String(index + 1)}`, subject, now),
      ),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(
      decisions
        .filter((decision) => !decision.allowed)
        .every((decision) => decision.retryAfterSeconds === 1),
    ).toBe(true);
    expect(JSON.stringify(await prisma.identityThrottle.findMany())).not.toContain(subject);
  });

  it('increases the delay, preserves it across instances, and expires at the window boundary', async () => {
    expect((await first.acquire('login', ip, subject, now)).allowed).toBe(true);
    expect(
      (await second.acquire('login', ip, subject, new Date(now.getTime() + 249))).allowed,
    ).toBe(false);
    expect(
      (await second.acquire('login', ip, subject, new Date(now.getTime() + 250))).allowed,
    ).toBe(true);
    expect((await first.acquire('login', ip, subject, new Date(now.getTime() + 749))).allowed).toBe(
      false,
    );
    expect((await first.acquire('login', ip, subject, new Date(now.getTime() + 750))).allowed).toBe(
      true,
    );
    expect(
      (await second.acquire('login', ip, subject, new Date(now.getTime() + 900000))).remaining,
    ).toBe(9);
  });

  it('enforces the IP quota across different accounts without resetting it on successful login', async () => {
    for (let index = 0; index < 100; index++) {
      expect(
        (await first.acquire('login', ip, `person${String(index)}@example.com`, now)).allowed,
      ).toBe(true);
      await first.succeeded(`person${String(index)}@example.com`);
    }
    expect(await second.acquire('login', ip, subject, now)).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 900,
    });
  });

  it('caps email requests and does not extend a blocked window on retries', async () => {
    for (let index = 0; index < 5; index++)
      expect((await first.acquire('email', ip, subject, now)).allowed).toBe(true);
    const blocked = await first.acquire('email', ip, subject, now);
    expect(blocked).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 3600 });
    expect(
      (await second.acquire('email', ip, subject, new Date(now.getTime() + 1000))).resetAt,
    ).toEqual(blocked.resetAt);
  });

  it('clears successful-login account delays while preserving unrelated scopes', async () => {
    await first.acquire('login', ip, subject, now);
    await first.acquire('reset', ip, subject, now);
    await second.succeeded(subject);
    expect((await first.acquire('login', ip, subject, now)).allowed).toBe(true);
    expect((await first.acquire('reset', ip, subject, now)).allowed).toBe(false);
  });
});
