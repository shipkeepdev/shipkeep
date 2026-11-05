import { TestBed } from '@angular/core/testing';

import { IdentityRequestError } from './identity-api';
import { MutationAttempt, MutationRunner } from './mutation-runner';

describe('identity mutation attempts', () => {
  it('reuses a key only for the same body within a conservative replay window', () => {
    const attempt = new MutationAttempt();
    const body = { password: 'private browser fixture' };
    const first = attempt.keyFor(body, 1000);
    expect(attempt.keyFor(body, 240999)).toBe(first);
    expect(JSON.stringify(attempt)).not.toContain(body.password);
    expect(() => attempt.keyFor(body, 241000)).toThrow('Start again');
    attempt.reset();
    expect(attempt.keyFor(body, 241000)).not.toBe(first);
    expect(attempt.keyFor({ password: 'changed fixture' }, 241001)).not.toBe(first);
  });

  it('does not extend a retry window when the clock goes backward', () => {
    const attempt = new MutationAttempt();
    attempt.keyFor({ code: 'fixture' }, 1000);
    expect(() => attempt.keyFor({ code: 'fixture' }, 999)).toThrow('Start again');
  });
});

describe('identity mutation runner', () => {
  let runner: MutationRunner;
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [MutationRunner] });
    runner = TestBed.inject(MutationRunner);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('preserves uncertain retries and drops known rejected attempts', async () => {
    const call = vi.fn<(key: string) => Promise<void>>();
    call.mockRejectedValueOnce(new IdentityRequestError(0));
    call.mockRejectedValueOnce(new IdentityRequestError(401));
    call.mockResolvedValue(undefined);
    await runner.run({ password: 'fixture' }, call);
    await runner.run({ password: 'fixture' }, call);
    await runner.run({ password: 'fixture' }, call);
    expect(call.mock.calls.at(0)?.at(0)).toEqual(call.mock.calls.at(1)?.at(0));
    expect(call.mock.calls.at(1)?.at(0)).not.toEqual(call.mock.calls.at(2)?.at(0));
    expect(runner.problem()).toBeNull();
  });

  it('blocks duplicate submissions and discards results after leaving the form', async () => {
    let finish: ((value: string) => void) | undefined;
    const call = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = runner.run({ password: 'fixture' }, call);
    expect(runner.busy()).toBe(true);
    expect(await runner.run({}, call)).toEqual({ ok: false });
    expect(call).toHaveBeenCalledTimes(1);
    runner.reset();
    finish?.('private grant');
    expect(await pending).toEqual({ ok: false });
    expect(runner.busy()).toBe(false);
    expect(JSON.stringify(runner)).not.toContain('private grant');
  });

  it('requires an explicit restart after a conflict or an expired uncertain attempt', async () => {
    const call = vi.fn<(key: string) => Promise<void>>();
    call.mockRejectedValueOnce(new IdentityRequestError(409));
    await runner.run({}, call);
    expect(runner.restartRequired()).toBe(true);
    await runner.run({}, call);
    expect(call).toHaveBeenCalledTimes(1);
    runner.reset();
    call.mockRejectedValueOnce(new IdentityRequestError(503));
    await runner.run({}, call);
    vi.advanceTimersByTime(240000);
    await runner.run({}, call);
    expect(call).toHaveBeenCalledTimes(2);
    expect(runner.restartRequired()).toBe(true);
  });

  it('bounds and enforces a retry delay, including a client restart', async () => {
    const call = vi.fn<(key: string) => Promise<void>>();
    call.mockRejectedValueOnce(new IdentityRequestError(429, 2));
    call.mockResolvedValue(undefined);
    await runner.run({}, call);
    runner.reset();
    await runner.run({}, call);
    expect(call).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(runner.cooldown()).toBe(1);
    vi.advanceTimersByTime(1000);
    await runner.run({}, call);
    expect(call).toHaveBeenCalledTimes(2);
    expect(runner.cooldown()).toBe(0);
  });

  it('does not expose arbitrary exceptions and releases state on destruction', async () => {
    const call = vi.fn<(key: string) => Promise<void>>();
    call.mockRejectedValueOnce(new Error('password=private fixture'));
    await runner.run({}, call);
    expect(runner.problem()).not.toContain('private');
    call.mockRejectedValueOnce(new IdentityRequestError(429, 360000));
    await runner.run({}, call);
    expect(runner.cooldown()).toBe(3600);
    TestBed.resetTestingModule();
    expect(vi.getTimerCount()).toBe(0);
    expect(await runner.run({}, call)).toEqual({ ok: false });
  });
});
