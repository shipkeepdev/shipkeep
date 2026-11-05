import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { INSTALLATION_KEY_STORE } from './modules/fleet/infrastructure/ca/installation-key-store';
import { DATA_KEY_STORE } from './platform/crypto/data-key-store';
import { PROBLEM_MEDIA_TYPE } from './platform/http/problem-details';
import { PrismaService } from './platform/prisma/prisma.service';
import { JobQueue } from './platform/jobs/job-queue';
import { MemoryDataKeyStore, MemoryInstallationKeyStore } from './testing/memory-stores';
import { ANONYMOUS } from './platform/http/allow-anonymous';
import { ROUTE_ACCESS, type RouteAccess } from './modules/identity/interface/route-access';

// HTTP pipeline tests. The database is replaced by a stub so they run without Postgres;
// the real connection is covered by the integration test (app.integration.spec.ts).
describe('HTTP pipeline', () => {
  let app: INestApplication;
  let pingOk = true;
  const http = (): ReturnType<typeof request> => request(app.getHttpServer() as Server);

  beforeAll(async () => {
    // Environment defaults come from src/test-setup.ts. Every store that would reach PostgreSQL
    // is replaced by an in-memory one; the database itself is covered by the integration tests.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATA_KEY_STORE)
      .useValue(new MemoryDataKeyStore())
      .overrideProvider(INSTALLATION_KEY_STORE)
      .useValue(new MemoryInstallationKeyStore())
      .overrideProvider(JobQueue)
      .useValue({})
      .compile();
    app = configureApp(moduleRef.createNestApplication({ bufferLogs: true }));
    const prisma = app.get(PrismaService);
    vi.spyOn(prisma, 'onModuleInit').mockResolvedValue(undefined);
    vi.spyOn(prisma, 'onModuleDestroy').mockResolvedValue(undefined);
    vi.spyOn(prisma, 'ping').mockImplementation(() => Promise.resolve(pingOk));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires an explicit access declaration on every registered controller route', () => {
    const reflector = app.get(Reflector);
    const scanner = new MetadataScanner();
    const routes: string[] = [];
    for (const module of app.get(ModulesContainer).values()) {
      for (const controller of module.controllers.values()) {
        const type = controller.metatype;
        if (!type) continue;
        const prototype = type.prototype as Record<string, unknown>;
        for (const name of scanner.getAllMethodNames(prototype)) {
          const handler = prototype[name];
          if (
            typeof handler !== 'function' ||
            reflector.get(METHOD_METADATA, handler) === undefined
          )
            continue;
          const path = `${String(reflector.get(PATH_METADATA, type))}/${String(reflector.get(PATH_METADATA, handler))}`;
          routes.push(path);
          const targets = [handler, type];
          const anonymous = reflector.getAllAndOverride<boolean | undefined>(ANONYMOUS, targets);
          const access = reflector.getAllAndOverride<RouteAccess | undefined>(
            ROUTE_ACCESS,
            targets,
          );
          expect(anonymous === true || access !== undefined, path).toBe(true);
          if (access?.kind === 'account' && !anonymous)
            expect(path, path).not.toMatch(/:(organizationId|projectId|environmentId)\b/);
        }
      }
    }
    expect(routes.length).toBeGreaterThan(10);
  });

  it('GET /api/v1/health reports ok with security headers', async () => {
    const res = await http().get('/api/v1/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', version: expect.any(String) as string });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('GET /api/v1/ready reflects the database probe', async () => {
    await http().get('/api/v1/ready').expect(200);
    pingOk = false;
    const res = await http().get('/api/v1/ready').expect(503);
    pingOk = true;
    expect(res.headers['content-type']).toContain(PROBLEM_MEDIA_TYPE);
    expect(res.body).toMatchObject({ status: 503, code: 'service_unavailable' });
  });

  it('unknown routes answer with problem details', async () => {
    const res = await http().get('/api/v1/nope').expect(404);
    expect(res.headers['content-type']).toContain(PROBLEM_MEDIA_TYPE);
    expect(res.body).toMatchObject({
      type: 'https://shipkeep.dev/problems/not_found',
      title: 'Not Found',
      status: 404,
      code: 'not_found',
      instance: '/api/v1/nope',
    });
  });

  it('does not reflect malformed JSON credentials or query strings in errors', async () => {
    const secret = 'private-parser-fixture';
    const response = await http()
      .post(`/api/v1/auth/login?token=${secret}`)
      .set('Content-Type', 'application/json')
      .send(`{"password":"${secret}" invalid}`)
      .expect(400);
    expect(response.body).toMatchObject({ instance: '/api/v1/auth/login', status: 400 });
    expect(JSON.stringify(response.body)).not.toContain(secret);
  });

  it('serves the OpenAPI 3.1 document and the UI when enabled', async () => {
    const res = await http().get('/api/v1/openapi.json').expect(200);
    const document = res.body as { openapi: string; info: { title: string }; paths: object };
    expect(document).toMatchObject({
      openapi: '3.1.0',
      info: { title: 'Shipkeep API' },
    });
    expect(document.paths).toHaveProperty('/api/v1/health');
    expect(document.paths).toHaveProperty('/api/v1/ready');
    expect(document.paths).toMatchObject({
      '/api/v1/api-tokens': {
        get: {
          parameters: expect.arrayContaining([
            expect.objectContaining({
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
            }),
          ]),
        },
      },
    });
    await http().get('/api/v1/docs').expect(200);
  });
});
