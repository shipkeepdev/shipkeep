import { throttlePolicy, usesSourceAxis } from './throttle-policy';

describe('authentication throttle policy', () => {
  it('bounds API traffic without delaying every successful machine request', () => {
    expect(throttlePolicy('api', 'ip')).toMatchObject({
      limit: 600,
      windowMs: 60000,
      progressive: false,
    });
    expect(throttlePolicy('api', 'subject')).toMatchObject({
      limit: 300,
      windowMs: 60000,
      progressive: false,
    });
    expect(usesSourceAxis('api')).toBe(false);
  });

  it('caps credential proofs per account and network, never per account alone', () => {
    expect(throttlePolicy('login', 'ip')).toMatchObject({ limit: 100, windowMs: 900000 });
    expect(throttlePolicy('login', 'source')).toMatchObject({
      limit: 10,
      windowMs: 900000,
      progressive: true,
      maxDelaySteps: 8,
    });
    const account = throttlePolicy('login', 'subject');
    expect(account.progressive).toBe(true);
    expect(account.limit).toBeGreaterThan(10_000);
    // The global account delay is bounded, so failures from elsewhere cannot lock the owner out.
    expect(250 * 2 ** account.maxDelaySteps).toBeLessThanOrEqual(8000);
    for (const attempt of ['login', 'verify', 'reset', 'mfa', 'token'] as const)
      expect(usesSourceAxis(attempt)).toBe(true);
  });

  it('keeps a hard per-account cap on email delivery to prevent mailbox flooding', () => {
    expect(throttlePolicy('email', 'subject')).toMatchObject({
      limit: 5,
      windowMs: 3600000,
      progressive: false,
    });
    expect(throttlePolicy('email', 'ip')).toMatchObject({ limit: 20, windowMs: 3600000 });
    expect(usesSourceAxis('email')).toBe(false);
    expect(usesSourceAxis('register')).toBe(false);
  });
});
