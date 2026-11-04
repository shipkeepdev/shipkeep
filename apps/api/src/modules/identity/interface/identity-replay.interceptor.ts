import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { ConflictError, InvalidInputError, Secret } from '@shipkeep/domain';
import type { Response } from 'express';
import { firstValueFrom, from, type Observable } from 'rxjs';
import { z } from 'zod';

import { AppConfig } from '../../../platform/config/app-config';
import { API_PREFIX } from '../../../platform/http/constants';
import { SessionCommands } from '../application/session-commands';
import { AuthenticationError } from '../domain/identity-policy';
import { PrivateIdentityReplay } from '../infrastructure/private-identity-replay';

import { cookiePolicy, type IdentityRequest, readCredential } from './session-http';

const resultSchema = z
  .object({ body: z.unknown(), cookies: z.array(z.string().max(4096)).max(2) })
  .strict();

@Injectable()
export class IdentityReplayInterceptor implements NestInterceptor {
  constructor(
    private readonly retries: PrivateIdentityReplay,
    private readonly sessions: SessionCommands,
    private readonly config: AppConfig,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    const key = request.headers['idempotency-key'];
    if (request.method !== 'POST' || key === undefined) return next.handle();
    if (typeof key !== 'string')
      throw new InvalidInputError(
        'invalid_idempotency_key',
        'A single idempotency key is required.',
      );
    const response = context.switchToHttp().getResponse<Response>();
    return from(this.execute(request, response, key, next));
  }

  private async execute(
    request: IdentityRequest,
    response: Response,
    key: string,
    next: CallHandler<unknown>,
  ): Promise<unknown> {
    const route = request.path.slice(`${API_PREFIX}/`.length);
    const body =
      request.body && typeof request.body === 'object' && !Array.isArray(request.body)
        ? Object.fromEntries(Object.entries(request.body).sort(([a], [b]) => a.localeCompare(b)))
        : request.body;
    // Anonymous account actions already prove their credentials in the body. Logout is bound
    // to the exact session/CSRF pair, so a retry cannot authorize a different browser session.
    const input = new Secret(
      JSON.stringify({
        body: body ?? null,
        ...(request.identity
          ? { userId: request.identity.userId, securityVersion: request.identity.securityVersion }
          : {}),
        ...(route === 'auth/logout'
          ? {
              cookie: request.headers.cookie,
              csrf: request.headers['x-shipkeep-csrf'],
              authorization: request.headers.authorization,
            }
          : {}),
      }),
    );
    try {
      const result = await this.retries.execute(route, key, input, async () => {
        const value = await firstValueFrom(next.handle());
        const cookies = response.getHeader('set-cookie') ?? [];
        const snapshot = resultSchema.parse({
          body: value ?? null,
          cookies: typeof cookies === 'string' ? [cookies] : cookies,
        });
        response.removeHeader('set-cookie');
        return new Secret(JSON.stringify(snapshot));
      });
      const snapshot = resultSchema.parse(JSON.parse(result.response.expose()) as unknown);
      if (result.replayed && route === 'auth/login') {
        // A later reset, logout, expiry or privilege change must invalidate cached grants too.
        const header = snapshot.cookies.map((cookie) => cookie.split(';')[0]).join('; ');
        try {
          await this.sessions.authenticate(
            readCredential(header, cookiePolicy(this.config.get('API_PUBLIC_URL')).name),
          );
        } catch (error: unknown) {
          if (!(error instanceof AuthenticationError)) throw error;
          throw new ConflictError(
            'idempotency_result_expired',
            'The prior session is no longer available. Use a new idempotency key.',
          );
        }
      }
      if (snapshot.cookies.length) response.setHeader('Set-Cookie', snapshot.cookies);
      response.setHeader('Idempotency-Replayed', result.replayed ? 'true' : 'false');
      return snapshot.body ?? undefined;
    } catch (error: unknown) {
      // Never send a credential created by a transaction that failed to commit its retry state.
      response.removeHeader('set-cookie');
      throw error;
    }
  }
}
