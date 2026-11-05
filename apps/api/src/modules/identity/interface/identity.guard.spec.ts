import type { Server } from 'node:http';

import { Controller, Get, type INestApplication, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Secret } from '@shipkeep/domain';
import request from 'supertest';

import { AppConfig } from '../../../platform/config/app-config';
import { parseConfig, type ParsedConfig } from '../../../platform/config/config.schema';
import { ProblemDetailsFilter } from '../../../platform/http/problem-details.filter';
import { IDENTITY_THROTTLE, type IdentityThrottle } from '../application/identity-throttle';
import { SessionCommands } from '../application/session-commands';
import { AuthenticationError } from '../domain/identity-policy';

import { AllowAnonymous, IdentityGuard } from './identity.guard';
import { IdentityAttemptLimit, IdentityRateGuard } from './identity-rate.guard';
import { type IdentityRequest, principal } from './session-http';

@Controller('fixture')
class FixtureController {
  @Get('public') @AllowAnonymous() publicRead() {
    return { ok: true };
  }
  @Post('public') @AllowAnonymous() @IdentityAttemptLimit('login') publicWrite() {
    return { ok: true };
  }
  @Get('private') privateRead(@Req() input: IdentityRequest) {
    return { id: principal(input).userId };
  }
  @Post('private') privateWrite(@Req() input: IdentityRequest) {
    return { id: principal(input).userId };
  }
}

describe('identity HTTP guards', () => {
  let app: INestApplication;
  const value = 'A'.repeat(43);
  const csrf = 'B'.repeat(43);
  const origin = 'https://shipkeep.example.com';
  const cookie = `__Host-shipkeep_session=${value}`;
  const config = new AppConfig(
    new ConfigService<ParsedConfig, true>(
      parseConfig({
        DATABASE_URL: 'postgresql://test:test@localhost/test',
        SHIPKEEP_KEK_FILE: '/unused/test/kek',
        API_PUBLIC_URL: origin,
      }),
    ),
  );
  const authenticate = vi.fn<SessionCommands['authenticate']>();
  const acquire = vi.fn<IdentityThrottle['acquire']>();
  const http = () => request(app.getHttpServer() as Server);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [FixtureController],
      providers: [
        { provide: AppConfig, useValue: config },
        { provide: SessionCommands, useValue: { authenticate } },
        { provide: IDENTITY_THROTTLE, useValue: { acquire } },
        { provide: APP_GUARD, useClass: IdentityGuard },
        { provide: APP_GUARD, useClass: IdentityRateGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate.mockImplementation((token, supplied) => {
      if (token.expose() !== value || (supplied && supplied.expose() !== csrf))
        return Promise.reject(new AuthenticationError());
      const now = new Date();
      return Promise.resolve({
        user: {
          id: 'user-id',
          email: 'person@example.com',
          passwordHash: new Secret('test-hash'),
          status: 'active',
          emailVerifiedAt: now,
          securityVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
        session: {
          id: 'session-id',
          userId: 'user-id',
          tokenHash: 'hash',
          csrfHash: 'csrf-hash',
          securityVersion: 1,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + 10000),
          revokedAt: null,
          ip: '127.0.0.1',
          userAgent: 'test',
        },
      });
    });
    acquire.mockResolvedValue({
      allowed: true,
      limit: 10,
      remaining: 9,
      resetAt: new Date(Date.now() + 900000),
      retryAfterSeconds: 0,
    });
  });

  it('denies access by default and only exempts explicitly anonymous routes', async () => {
    await http().get('/fixture/public').expect(200);
    await http().get('/fixture/private').expect(401);
    const response = await http().get('/fixture/private').set('Cookie', cookie).expect(200);
    expect(response.body).toEqual({ id: 'user-id' });
    expect(JSON.stringify(response.body)).not.toContain('test-hash');
  });

  it('requires matching origin and session-bound CSRF for cookie mutations', async () => {
    await http().post('/fixture/private').set('Cookie', cookie).expect(403);
    await http()
      .post('/fixture/private')
      .set('Cookie', cookie)
      .set('Origin', 'https://attacker.example.com')
      .set('X-Shipkeep-CSRF', csrf)
      .expect(403);
    await http().post('/fixture/private').set('Cookie', cookie).set('Origin', origin).expect(401);
    await http()
      .post('/fixture/private')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-Shipkeep-CSRF', 'C'.repeat(43))
      .expect(401);
    await http()
      .post('/fixture/private')
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-Shipkeep-CSRF', csrf)
      .expect(201);
  });

  it('also protects anonymous mutations against cross-site submission', async () => {
    await http().post('/fixture/public').expect(403);
    await http()
      .post('/fixture/public')
      .set('Origin', origin)
      .set('Sec-Fetch-Site', 'cross-site')
      .expect(403);
    expect(acquire).not.toHaveBeenCalled();
    await http()
      .post('/fixture/public')
      .set('Origin', origin)
      .send({ email: 'Person@EXAMPLE.com' })
      .expect(201);
    expect(acquire).toHaveBeenCalledWith('login', expect.any(String), 'person@example.com');
  });

  it('rejects ambiguous cookies and never falls back from a bearer header to a session', async () => {
    await http().get('/fixture/private').set('Cookie', `${cookie}; ${cookie}`).expect(401);
    await http()
      .get('/fixture/private')
      .set('Cookie', cookie)
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('ignores untrusted forwarded IPs and returns quota/retry metadata', async () => {
    acquire.mockResolvedValue({
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: new Date(Date.now() + 900000),
      retryAfterSeconds: 30,
    });
    const response = await http()
      .post('/fixture/public')
      .set('Origin', origin)
      .set('X-Forwarded-For', '198.51.100.123')
      .send({ email: 'person@example.com' })
      .expect(429);
    expect(acquire.mock.calls[0]?.[1]).not.toBe('198.51.100.123');
    expect(response.headers).toMatchObject({
      'ratelimit-limit': '10',
      'ratelimit-remaining': '0',
      'retry-after': '30',
    });
    expect(response.body).toMatchObject({ status: 429, code: 'too_many_requests' });
  });
});
