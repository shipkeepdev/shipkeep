import type { Server } from 'node:http';

import { Controller, Get, type INestApplication, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { NotFoundError, Secret } from '@shipkeep/domain';
import request from 'supertest';

import { TenantAccess } from '../../organizations/application/tenant-access';
import { AppConfig } from '../../../platform/config/app-config';
import { parseConfig, type ParsedConfig } from '../../../platform/config/config.schema';
import { ProblemDetailsFilter } from '../../../platform/http/problem-details.filter';
import { IDENTITY_THROTTLE, type IdentityThrottle } from '../application/identity-throttle';
import { SessionCommands } from '../application/session-commands';
import { ApiTokenAuthentication } from '../application/api-token-authentication';
import { AuthenticationError } from '../domain/identity-policy';

import { AllowAnonymous, IdentityGuard } from './identity.guard';
import { AllowApiToken } from './api-token-access';
import { AllowAccount, RequireTenant } from './route-access';
import { IdentityAttemptLimit, IdentityRateGuard } from './identity-rate.guard';
import { authenticatedPrincipal, type IdentityRequest, principal } from './session-http';

@Controller('fixture')
class FixtureController {
  @Post('token')
  @AllowAccount()
  @AllowApiToken('profile.read')
  @IdentityAttemptLimit('api')
  tokenWrite(@Req() input: IdentityRequest) {
    return { kind: authenticatedPrincipal(input).kind };
  }
  @Get('undeclared') @AllowApiToken('profile.read') undeclared() {
    return { ok: true };
  }
  @Get('resources/:organizationId/:projectId/:environmentId')
  @RequireTenant('environment.read', 'environment')
  @AllowApiToken('environment.read')
  resourceRead() {
    return { ok: true };
  }
  @Get('mismatch/:organizationId/:projectId')
  @RequireTenant('project.update', 'project')
  @AllowApiToken('project.read')
  mismatchRead() {
    return { ok: true };
  }
  @Get('account/:organizationId') @AllowAccount() accountResource() {
    return { ok: true };
  }
  @Get('public') @AllowAnonymous() publicRead() {
    return { ok: true };
  }
  @Post('public') @AllowAnonymous() @IdentityAttemptLimit('login') publicWrite() {
    return { ok: true };
  }
  @Get('private') @AllowAccount() privateRead(@Req() input: IdentityRequest) {
    return { id: principal(input).userId };
  }
  @Post('private') @AllowAccount() privateWrite(@Req() input: IdentityRequest) {
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
  const authenticateToken = vi.fn<ApiTokenAuthentication['authenticate']>();
  const requireTenant = vi.fn<TenantAccess['require']>();
  const acquire = vi.fn<IdentityThrottle['acquire']>();
  const http = () => request(app.getHttpServer() as Server);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [FixtureController],
      providers: [
        { provide: AppConfig, useValue: config },
        { provide: TenantAccess, useValue: { require: requireTenant } },
        { provide: SessionCommands, useValue: { authenticate } },
        { provide: ApiTokenAuthentication, useValue: { authenticate: authenticateToken } },
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
    requireTenant.mockResolvedValue(undefined);
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

  it('denies undeclared routes even with valid session or bearer credentials', async () => {
    await http().get('/fixture/undeclared').set('Cookie', cookie).expect(401);
    await http().get('/fixture/undeclared').set('Authorization', `Bearer ${value}`).expect(401);
    expect(authenticate).not.toHaveBeenCalled();
    expect(authenticateToken).not.toHaveBeenCalled();
  });

  const organizationId = '019d0000-0000-7000-8000-000000000001';
  const projectId = '019d0000-0000-7000-8000-000000000002';
  const environmentId = '019d0000-0000-7000-8000-000000000003';
  const resourcePath = `/fixture/resources/${organizationId}/${projectId}/${environmentId}`;
  const target = { organizationId, projectId, environmentId };

  it('uses path ancestry and live authorization on every session resource request', async () => {
    await http()
      .get(resourcePath)
      .set('Cookie', cookie)
      .query({ organizationId: 'attacker', role: 'owner', protected: false })
      .expect(200);
    expect(requireTenant).toHaveBeenCalledWith('user-id', 'environment.read', target);
    requireTenant.mockRejectedValue(new NotFoundError('resource'));
    const denied = await http().get(resourcePath).set('Cookie', cookie).expect(404);
    expect(denied.body).toMatchObject({ code: 'resource_not_found' });
    expect(requireTenant).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed ancestry and account declarations on resource paths', async () => {
    await http()
      .get(`/fixture/resources/${organizationId}/invalid/${environmentId}`)
      .set('Cookie', cookie)
      .expect(404);
    await http().get(`/fixture/account/${organizationId}`).set('Cookie', cookie).expect(401);
    expect(authenticate).not.toHaveBeenCalled();
    expect(requireTenant).not.toHaveBeenCalled();
  });

  it('binds bearer authorization to the exact tenant target and declared permission', async () => {
    const session = await authenticate(new Secret(value));
    authenticateToken.mockResolvedValue({
      user: session.user,
      token: {
        id: 'api-token-id',
        userId: session.user.id,
        name: 'Fixture',
        tokenHash: 'hash',
        scopes: [{ permission: 'environment.read', ...target }],
        securityVersion: 1,
        createdAt: new Date(),
        expiresAt: session.session.expiresAt,
        revokedAt: null,
        lastUsedAt: null,
        project: null,
      },
    });
    await http().get(resourcePath).set('Authorization', `Bearer ${value}`).expect(200);
    expect(authenticateToken).toHaveBeenCalledWith(expect.any(Secret), 'environment.read', target);
    authenticateToken.mockClear();
    await http()
      .get(`/fixture/mismatch/${organizationId}/${projectId}`)
      .set('Authorization', `Bearer ${value}`)
      .expect(401);
    expect(authenticateToken).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledTimes(2);
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

  it('allows explicit bearer mutations without ambient CSRF credentials and keeps session checks', async () => {
    const session = await authenticate(new Secret(value));
    authenticate.mockClear();
    authenticateToken.mockResolvedValue({
      user: session.user,
      token: {
        id: 'api-token-id',
        userId: session.user.id,
        name: 'Fixture',
        tokenHash: 'hash',
        scopes: [{ permission: 'profile.read' }],
        securityVersion: 1,
        createdAt: new Date(),
        expiresAt: session.session.expiresAt,
        revokedAt: null,
        lastUsedAt: null,
        project: null,
      },
    });
    const response = await http()
      .post('/fixture/token')
      .set('Authorization', `Bearer ${value}`)
      .expect(201);
    expect(response.body).toEqual({ kind: 'api_token' });
    expect(authenticate).not.toHaveBeenCalled();
    expect(authenticateToken).toHaveBeenCalledWith(expect.any(Secret), 'profile.read', {});
    expect(acquire).toHaveBeenCalledTimes(1);
    await http().post('/fixture/token').set('Cookie', cookie).expect(403);
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
