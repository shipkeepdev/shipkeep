import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';

import {
  browserRequest,
  IDENTITY_FETCH,
  IdentityApi,
  IdentityRequestError,
  requestProblem,
} from './identity-api';

describe('browser identity transport', () => {
  const origin = 'https://shipkeep.example.com';
  const csrf = 'A'.repeat(43);
  const document = {
    location: { origin, protocol: 'https:' },
    cookie: `__Host-shipkeep_csrf=${csrf}`,
  };
  const send = vi.fn<(request: Request) => Promise<Response>>();
  let api: IdentityApi;
  beforeEach(() => {
    send.mockReset();
    TestBed.configureTestingModule({
      providers: [
        { provide: DOCUMENT, useValue: document },
        { provide: IDENTITY_FETCH, useValue: send },
      ],
    });
    api = TestBed.inject(IdentityApi);
  });
  it('sends credentials only in same-origin bodies/headers and binds retry keys', async () => {
    send.mockResolvedValue(
      new Response(
        JSON.stringify({
          userId: 'fixture',
          email: 'person@example.com',
          expiresAt: '2030-01-01T00:00:00Z',
        }),
      ),
    );
    const password = 'correct horse browser fixture';
    await api.login({ email: 'person@example.com', password }, 'test-request-key');
    const input = send.mock.calls.at(0)?.at(0);
    if (!input) throw new Error('missing request');
    expect(input.url).toBe(`${origin}/api/v1/auth/login`);
    expect(input.credentials).toBe('same-origin');
    expect(input.cache).toBe('no-store');
    expect(input.redirect).toBe('error');
    expect(input.headers.get('idempotency-key')).toBe('test-request-key');
    expect(input.headers.get('x-shipkeep-csrf')).toBe(csrf);
    expect(input.headers.has('origin')).toBe(false);
    expect(input.headers.has('authorization')).toBe(false);
    expect(await input.json()).toEqual({ email: 'person@example.com', password });
    expect(input.url).not.toContain(password);
  });
  it('rejects cross-origin and non-API destinations before sending cookies', () => {
    for (const url of ['https://attacker.example.com/api/v1/auth/login', `${origin}/outside`])
      expect(() => browserRequest(new Request(url), origin, document.cookie)).toThrow(
        'Request could not be sent.',
      );
    expect(() =>
      browserRequest(
        new Request(`${origin}/api/v1/auth/session`, { headers: { authorization: 'Bearer test' } }),
        origin,
        '',
      ),
    ).toThrow('Request could not be sent.');
  });

  it('bounds network waits and preserves caller cancellation', async () => {
    const input = browserRequest(new Request(`${origin}/api/v1/auth/session`), origin, '', 1);
    await new Promise<void>((resolve) => {
      input.signal.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    });
    expect(input.signal.aborted).toBe(true);
    const cancel = new AbortController();
    cancel.abort();
    const cancelled = browserRequest(
      new Request(`${origin}/api/v1/auth/session`, { signal: cancel.signal }),
      origin,
      '',
    );
    expect(cancelled.signal.aborted).toBe(true);
  });
  it('does not fall back to insecure or ambiguous CSRF cookies', () => {
    for (const cookie of [
      `shipkeep_csrf=${csrf}`,
      `__Host-shipkeep_csrf=${csrf}; __Host-shipkeep_csrf=${csrf}`,
    ]) {
      const input = browserRequest(
        new Request(`${origin}/api/v1/auth/logout`, { method: 'POST' }),
        origin,
        cookie,
      );
      expect(input.headers.has('x-shipkeep-csrf')).toBe(false);
    }
  });
  it('uses bounded retry metadata and safe messages instead of server or network details', async () => {
    send.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'password=private fixture', status: 429 }), {
        status: 429,
        headers: { 'retry-after': '60' },
      }),
    );
    const failure: unknown = await api.session().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IdentityRequestError);
    if (!(failure instanceof IdentityRequestError)) throw new Error('missing safe error');
    expect(failure.retryAfterSeconds).toBe(60);
    expect(failure.message).not.toContain('private');
    send.mockRejectedValue(new Error('transport contains private fixture'));
    await expect(api.session()).rejects.toThrow('Connection lost.');
  });
  it('handles empty successful responses without parsing a credential into state', async () => {
    send.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      api.verifyEmail({ token: 'B'.repeat(43), password: 'private fixture' }, 'request-key'),
    ).resolves.toBeUndefined();
    await expect(api.logout('request-key')).resolves.toBeUndefined();
    await expect(api.session()).rejects.toThrow('temporarily unavailable');
  });
});

describe('requestProblem', () => {
  it('keeps only a well-formed code and a small index', () => {
    expect(
      requestProblem({ code: 'node_public_address_invalid', details: { index: 2 }, title: 'x' }),
    ).toEqual({ code: 'node_public_address_invalid', index: 2 });
    expect(
      requestProblem({ code: 'domain_taken', details: { hostname: 'a.example.com' } }),
    ).toEqual({ code: 'domain_taken' });
    for (const body of [
      undefined,
      null,
      'text',
      { code: 42 },
      { code: '<script>' },
      { code: 'x'.repeat(65) },
    ])
      expect(requestProblem(body)).toBeUndefined();
    for (const index of [-1, 1.5, 1000, '1'])
      expect(requestProblem({ code: 'a_b', details: { index } })).toEqual({ code: 'a_b' });
  });
});
