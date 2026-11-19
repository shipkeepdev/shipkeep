import { Code, ConnectError } from '@connectrpc/connect';

import {
  ENROLLMENT_LIMITS,
  EnrollmentAdmission,
  type EnrollmentLimits,
} from './enrollment-admission';

const limits: EnrollmentLimits = {
  perNetwork: 3,
  windowMs: 60_000,
  maxNetworks: 4,
  concurrent: 2,
  queued: 2,
  maxWaitMs: 1_000,
};

/** A unit of work the test finishes when it wants. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, work: () => opened };
}

const busy = (promise: Promise<unknown>) =>
  expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof ConnectError && error.code === Code.ResourceExhausted,
  );

describe('EnrollmentAdmission', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows each network its quota per window, then again in the next window', () => {
    let now = 0;
    const admission = new EnrollmentAdmission(limits, () => now);
    expect([1, 2, 3, 4].map(() => admission.allow('203.0.113.7'))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    // Another network has its own quota.
    expect(admission.allow('198.51.100.1')).toBe(true);
    now = 60_000;
    expect(admission.allow('203.0.113.7')).toBe(true);
  });

  it('counts an IPv6 /64 as one network, and an IPv4-mapped address as its IPv4 address', () => {
    const admission = new EnrollmentAdmission(limits, () => 0);
    for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2::ffff', '2001:db8:1:2:aaaa::9'])
      expect(admission.allow(ip)).toBe(true);
    expect(admission.allow('2001:db8:1:2::42')).toBe(false);
    expect(admission.allow('2001:db8:1:3::1')).toBe(true);
    for (const ip of ['192.0.2.5', '::ffff:192.0.2.5', '192.0.2.5']) admission.allow(ip);
    expect(admission.allow('::ffff:192.0.2.5')).toBe(false);
  });

  it('puts networks beyond the tracked count, and peers without an address, in one shared quota', () => {
    let now = 0;
    const admission = new EnrollmentAdmission(limits, () => now);
    for (let i = 1; i <= 4; i++) expect(admission.allow(`192.0.2.${String(i)}`)).toBe(true);
    // The table is full: every new network now shares one quota, so rotating addresses gains
    // nothing.
    const fresh = ['198.51.100.1', '198.51.100.2', undefined, '198.51.100.3'];
    expect(fresh.map((ip) => admission.allow(ip))).toEqual([true, true, true, false]);
    // Once the old windows end, they are forgotten and new networks get their own quota.
    now = 60_000;
    expect(admission.allow('198.51.100.9')).toBe(true);
  });

  it('runs at most the budget at once, queues a few, and refuses the rest at once', async () => {
    const admission = new EnrollmentAdmission(limits);
    const gates = [gate(), gate(), gate(), gate()];
    const runs = gates.map((g) => admission.run(g.work));
    expect(admission.load()).toEqual({ running: 2, waiting: 2 });
    await busy(admission.run(() => Promise.resolve()));
    gates.forEach((g) => {
      g.open();
    });
    await Promise.all(runs);
    expect(admission.load()).toEqual({ running: 0, waiting: 0 });
  });

  it('hands a freed slot to the next waiter, never past the budget', async () => {
    const admission = new EnrollmentAdmission(limits);
    let active = 0;
    let peak = 0;
    const work = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    };
    await Promise.all([1, 2, 3, 4].map(() => admission.run(work)));
    expect(peak).toBe(2);
    expect(admission.load()).toEqual({ running: 0, waiting: 0 });
  });

  it('refuses a waiter after the longest wait, and frees its place in the queue', async () => {
    vi.useFakeTimers();
    const admission = new EnrollmentAdmission(limits);
    const held = [gate(), gate()];
    const runs = held.map((g) => admission.run(g.work));
    const waiting = admission.run(() => Promise.resolve('late'));
    const refused = busy(waiting);
    await vi.advanceTimersByTimeAsync(1_000);
    await refused;
    expect(admission.load()).toEqual({ running: 2, waiting: 0 });
    held.forEach((g) => {
      g.open();
    });
    await Promise.all(runs);
    expect(admission.load()).toEqual({ running: 0, waiting: 0 });
  });

  it('drops a waiter whose caller gave up, and refuses a call already abandoned', async () => {
    const admission = new EnrollmentAdmission(limits);
    const held = [gate(), gate()];
    const runs = held.map((g) => admission.run(g.work));
    const caller = new AbortController();
    let ran = false;
    const waiting = admission.run(() => {
      ran = true;
      return Promise.resolve();
    }, caller.signal);
    caller.abort();
    await busy(waiting);
    expect(admission.load().waiting).toBe(0);
    await busy(admission.run(() => Promise.resolve(), caller.signal));
    held.forEach((g) => {
      g.open();
    });
    await Promise.all(runs);
    expect(ran).toBe(false);
    expect(admission.load()).toEqual({ running: 0, waiting: 0 });
  });

  it('frees the slot of work that fails', async () => {
    const admission = new EnrollmentAdmission(limits);
    await expect(admission.run(() => Promise.reject(new Error('store down')))).rejects.toThrow(
      'store down',
    );
    expect(admission.load()).toEqual({ running: 0, waiting: 0 });
  });

  it('answers a refusal with no detail from the caller', async () => {
    const admission = new EnrollmentAdmission({ ...limits, concurrent: 1, queued: 0 });
    const held = gate();
    const run = admission.run(held.work);
    const error = await admission.run(() => Promise.resolve()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).rawMessage).toBe('enrollment is busy, retry later');
    held.open();
    await run;
  });

  it('keeps defaults that fit within the RPC deadline', () => {
    expect(ENROLLMENT_LIMITS.maxWaitMs).toBeLessThan(30_000);
    expect(ENROLLMENT_LIMITS.concurrent).toBeGreaterThan(0);
  });
});
