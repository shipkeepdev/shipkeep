import { TestBed } from '@angular/core/testing';
import {
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
  type ResolveFn,
} from '@angular/router';

import { AuthOptions, authOptions } from './auth-options';
import { IdentityApi, IdentityRequestError } from './identity-api';

describe('what the sign-in screens may offer', () => {
  const api = { options: vi.fn<IdentityApi['options']>() };
  let options: AuthOptions;
  /** An answer the test gives when it chooses. */
  function pending(): { answer: (email: boolean) => void; fail: () => void } {
    let answer: (email: boolean) => void = () => undefined;
    let fail: () => void = () => undefined;
    api.options.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          answer = (email) => {
            resolve({ email });
          };
          fail = () => {
            reject(new IdentityRequestError(0));
          };
        }),
    );
    return {
      answer: (email) => {
        answer(email);
      },
      fail: () => {
        fail();
      },
    };
  }
  const resolve = (resolver: ResolveFn<void>) =>
    TestBed.runInInjectionContext(
      () => resolver({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot) as Promise<void>,
    );

  beforeEach(() => {
    vi.resetAllMocks();
    TestBed.configureTestingModule({ providers: [{ provide: IdentityApi, useValue: api }] });
    options = TestBed.inject(AuthOptions);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers everything until the server says that it sends no email', async () => {
    expect(options.email()).toBe(true);
    api.options.mockResolvedValueOnce({ email: false });
    await options.refresh();
    expect(options.email()).toBe(false);
  });

  it('makes only the first screen wait; the next ones show the last answer meanwhile', async () => {
    const first = pending();
    let shown = false;
    const waiting = options.refresh().then(() => {
      shown = true;
    });
    await Promise.resolve();
    expect(shown).toBe(false);
    first.answer(false);
    await waiting;
    expect(options.email()).toBe(false);

    // Email was turned on since: the next screen is not held, and shows it once the answer is in.
    const second = pending();
    await options.refresh();
    expect(options.email()).toBe(false);
    second.answer(true);
    await vi.waitFor(() => {
      expect(options.email()).toBe(true);
    });
  });

  it('keeps what the screens show when the question gets no answer, and asks again', async () => {
    api.options.mockRejectedValueOnce(new IdentityRequestError(0));
    await options.refresh();
    expect(options.email()).toBe(true);
    api.options.mockResolvedValueOnce({ email: false });
    await options.refresh();
    expect(options.email()).toBe(false);
    api.options.mockRejectedValueOnce(new IdentityRequestError(503));
    await options.refresh();
    expect(options.email()).toBe(false);
    expect(api.options).toHaveBeenCalledTimes(3);
  });

  it('ignores an answer that arrives after a newer question', async () => {
    const slow = pending();
    const first = options.refresh();
    const fast = pending();
    const second = options.refresh();
    fast.answer(false);
    await second;
    slow.answer(true);
    await first;
    expect(options.email()).toBe(false);
  });

  it('holds a screen for the answer, but never longer than two seconds', async () => {
    vi.useFakeTimers();
    api.options.mockResolvedValueOnce({ email: false });
    await resolve(authOptions);
    expect(options.email()).toBe(false);
    // An answer in time leaves no timer behind.
    expect(vi.getTimerCount()).toBe(0);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: IdentityApi, useValue: api }] });
    options = TestBed.inject(AuthOptions);
    const late = pending();
    let shown = false;
    const held = resolve(authOptions).then(() => {
      shown = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(shown).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await held;
    // Shown as an installation that sends email; the late answer then corrects the screen.
    expect(options.email()).toBe(true);
    late.answer(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(options.email()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
