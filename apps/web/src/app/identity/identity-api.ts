import { DOCUMENT } from '@angular/common';
import { inject, Injectable, InjectionToken } from '@angular/core';
import { type components, createShipkeepClient } from '@shipkeep/api-client';

export type IdentitySchema<T extends keyof components['schemas']> = components['schemas'][T];
export type SessionProfile = IdentitySchema<'SessionDto'>;
export const IDENTITY_FETCH = new InjectionToken<(input: Request) => Promise<Response>>(
  'IdentityFetch',
  {
    providedIn: 'root',
    factory: () => (input) => fetch(input),
  },
);
type Result<T> = { data?: T; response: Response };

/** Safe, bounded UI diagnostics. Never forward server details or transport exception strings. */
export class IdentityRequestError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds = 0,
  ) {
    super(
      status === 0
        ? 'Connection lost. You can retry this request.'
        : status === 401
          ? 'Your credentials could not be verified.'
          : status === 403
            ? 'This action is not permitted for your account.'
            : status === 404
              ? 'This item is no longer available.'
              : status === 409
                ? 'This request can no longer be replayed. Start a new request.'
                : status === 429
                  ? 'Too many attempts. Wait before trying again.'
                  : status >= 500
                    ? 'The service is temporarily unavailable. Try again shortly.'
                    : 'Check your information and try again.',
    );
    this.name = 'IdentityRequestError';
  }
}

export function newMutationKey(): string {
  return crypto.randomUUID();
}

/** Cookie credentials never leave this origin, follow redirects, or enter browser storage. */
export function browserRequest(input: Request, origin: string, cookie: string): Request {
  const url = new URL(input.url);
  if (
    url.origin !== origin ||
    !url.pathname.startsWith('/api/v1/') ||
    input.headers.has('authorization')
  )
    throw new Error('Request could not be sent.');
  const headers = new Headers(input.headers);
  // Browsers set Origin themselves. Generated request types also describe non-browser clients.
  headers.delete('origin');
  headers.delete('x-shipkeep-csrf');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(input.method)) {
    const name = `${url.protocol === 'https:' ? '__Host-' : ''}shipkeep_csrf=`;
    const values = cookie
      .split(';')
      .map((value) => value.trim())
      .filter((value) => value.startsWith(name));
    const value = values.length === 1 ? values.at(0)?.slice(name.length) : undefined;
    if (value && /^[A-Za-z0-9_-]{43}$/.test(value)) headers.set('X-Shipkeep-CSRF', value);
  }
  return new Request(input, {
    headers,
    credentials: 'same-origin',
    mode: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
  });
}

@Injectable({ providedIn: 'root' })
export class IdentityApi {
  private readonly document = inject(DOCUMENT);
  private readonly send = inject(IDENTITY_FETCH);
  private readonly origin = this.document.location.origin;
  private readonly client = createShipkeepClient({
    baseUrl: this.origin,
    fetch: (input: Request) => this.send(browserRequest(input, this.origin, this.document.cookie)),
  });

  session(): Promise<SessionProfile> {
    return this.required(() => this.client.GET('/api/v1/auth/session'));
  }
  login(body: IdentitySchema<'LoginCredentialsDto'>, key: string): Promise<SessionProfile> {
    return this.required(() =>
      this.client.POST('/api/v1/auth/login', { body, params: this.params(key) }),
    );
  }
  async register(body: IdentitySchema<'CredentialsDto'>, key: string): Promise<void> {
    await this.execute(() =>
      this.client.POST('/api/v1/auth/register', { body, params: this.params(key) }),
    );
  }
  async requestVerification(email: string, key: string): Promise<void> {
    await this.execute(() =>
      this.client.POST('/api/v1/auth/verification/request', {
        body: { email },
        params: this.params(key),
      }),
    );
  }
  async verifyEmail(token: string, key: string): Promise<void> {
    await this.execute(() =>
      this.client.POST('/api/v1/auth/verify', { body: { token }, params: this.params(key) }),
    );
  }
  async requestPasswordReset(email: string, key: string): Promise<void> {
    await this.execute(() =>
      this.client.POST('/api/v1/auth/reset/request', { body: { email }, params: this.params(key) }),
    );
  }
  async resetPassword(body: IdentitySchema<'ResetPasswordDto'>, key: string): Promise<void> {
    await this.execute(() =>
      this.client.POST('/api/v1/auth/reset', { body, params: this.params(key) }),
    );
  }
  async logout(key: string): Promise<void> {
    await this.execute(() => this.client.POST('/api/v1/auth/logout', { params: this.params(key) }));
  }
  mfaStatus(): Promise<IdentitySchema<'MfaStatusDto'>> {
    return this.required(() => this.client.GET('/api/v1/auth/mfa'));
  }
  setupMfa(
    body: IdentitySchema<'MfaPasswordDto'>,
    key: string,
  ): Promise<IdentitySchema<'MfaSetupDto'>> {
    return this.required(() =>
      this.client.POST('/api/v1/auth/mfa/setup', { body, params: this.params(key) }),
    );
  }
  enableMfa(
    body: IdentitySchema<'EnableMfaDto'>,
    key: string,
  ): Promise<IdentitySchema<'MfaRecoveryDto'>> {
    return this.required(() =>
      this.client.POST('/api/v1/auth/mfa/enable', { body, params: this.params(key) }),
    );
  }
  disableMfa(body: IdentitySchema<'ReauthenticateMfaDto'>, key: string): Promise<SessionProfile> {
    return this.required(() =>
      this.client.POST('/api/v1/auth/mfa/disable', { body, params: this.params(key) }),
    );
  }
  regenerateRecovery(
    body: IdentitySchema<'ReauthenticateMfaDto'>,
    key: string,
  ): Promise<IdentitySchema<'MfaRecoveryDto'>> {
    return this.required(() =>
      this.client.POST('/api/v1/auth/mfa/recovery', { body, params: this.params(key) }),
    );
  }
  listTokens(cursor?: string): Promise<IdentitySchema<'ApiTokenPageDto'>> {
    return this.required(() =>
      this.client.GET('/api/v1/api-tokens', {
        params: { query: { ...(cursor ? { cursor } : {}), limit: 100 } },
      }),
    );
  }
  createToken(
    body: IdentitySchema<'CreateApiTokenDto'>,
    key: string,
  ): Promise<IdentitySchema<'ApiTokenCreatedDto'>> {
    return this.required(() =>
      this.client.POST('/api/v1/api-tokens', { body, params: this.params(key) }),
    );
  }
  async revokeToken(
    id: string,
    body: IdentitySchema<'ReauthenticateMfaDto'>,
    key: string,
  ): Promise<void> {
    await this.execute(() =>
      this.client.POST('/api/v1/api-tokens/{id}/revoke', {
        body,
        params: { ...this.params(key), path: { id } },
      }),
    );
  }
  private params(key: string) {
    return { header: { Origin: this.origin, 'X-Shipkeep-CSRF': '', 'Idempotency-Key': key } };
  }
  private async required<T>(call: () => Promise<Result<T>>): Promise<T> {
    const data = await this.execute(call);
    if (data === undefined) throw new IdentityRequestError(503);
    return data;
  }
  private async execute<T>(call: () => Promise<Result<T>>): Promise<T | undefined> {
    try {
      const result = await call();
      if (!result.response.ok) {
        const seconds = Number(result.response.headers.get('retry-after'));
        throw new IdentityRequestError(
          result.response.status,
          Number.isFinite(seconds) ? Math.max(0, Math.min(3600, Math.ceil(seconds))) : 0,
        );
      }
      return result.data;
    } catch (error: unknown) {
      if (error instanceof IdentityRequestError) throw error;
      throw new IdentityRequestError(0);
    }
  }
}
