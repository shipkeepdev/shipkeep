import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
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

  it('serves the OpenAPI 3.1 document and the UI when enabled', async () => {
    const res = await http().get('/api/v1/openapi.json').expect(200);
    const document = res.body as { openapi: string; info: { title: string }; paths: object };
    expect(document).toMatchObject({
      openapi: '3.1.0',
      info: { title: 'Shipkeep API' },
    });
    expect(document.paths).toHaveProperty('/api/v1/health');
    expect(document.paths).toHaveProperty('/api/v1/ready');
    await http().get('/api/v1/docs').expect(200);
  });
});
