import { FAILED_SESSION_LIMIT, FAILED_SESSION_WINDOW_MS, FailedSessions } from './failed-sessions';

describe('FailedSessions', () => {
  it('holds a network back after too many failures, until its window ends', () => {
    const failures = new FailedSessions();
    for (let i = 0; i < FAILED_SESSION_LIMIT - 1; i++) failures.record('198.51.100.7', 1000 + i);
    expect(failures.blockedUntil('198.51.100.7', 2000)).toBeUndefined();
    failures.record('198.51.100.7', 2000);
    expect(failures.blockedUntil('198.51.100.7', 2001)).toBe(1000 + FAILED_SESSION_WINDOW_MS);
    // Another network is not affected.
    expect(failures.blockedUntil('198.51.100.8', 2001)).toBeUndefined();
    // The window ends: the network starts again from zero.
    expect(failures.blockedUntil('198.51.100.7', 1000 + FAILED_SESSION_WINDOW_MS)).toBeUndefined();
    failures.record('198.51.100.7', 1000 + FAILED_SESSION_WINDOW_MS + 1);
    expect(
      failures.blockedUntil('198.51.100.7', 1000 + FAILED_SESSION_WINDOW_MS + 2),
    ).toBeUndefined();
  });

  it('counts one IPv6 /64 as one network', () => {
    const failures = new FailedSessions();
    for (let i = 0; i < FAILED_SESSION_LIMIT; i++)
      failures.record(`2001:db8:1:2::${i.toString(16)}`, 1000);
    expect(failures.blockedUntil('2001:db8:1:2:ffff::1', 1001)).toBeDefined();
    expect(failures.blockedUntil('2001:db8:1:3::1', 1001)).toBeUndefined();
  });

  it('keeps its memory bounded under a flood of networks', () => {
    const failures = new FailedSessions();
    for (let i = 0; i < 25_000; i++)
      failures.record(
        `10.${String((i >> 16) & 255)}.${String((i >> 8) & 255)}.${String(i & 255)}`,
        1000,
      );
    const size = (failures as unknown as { networks: Map<string, unknown> }).networks.size;
    expect(size).toBeLessThanOrEqual(10_000);
  });
});
