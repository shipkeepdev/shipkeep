import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { AppConfig } from './platform/config/app-config';
import { API_VERSION } from './platform/health/health.controller';
import { API_PREFIX } from './platform/http/constants';
import { ProblemDetailsFilter } from './platform/http/problem-details.filter';
import { createValidationPipe } from './platform/http/validation.pipe';
import { buildOpenApiDocument, serveOpenApi } from './platform/openapi/openapi';

/**
 * Applies the HTTP pipeline (prefix, security headers, validation, problem details, OpenAPI) to an
 * application instance. Shared by createApp and the HTTP tests, which build their instance from a
 * testing module with stubbed infrastructure.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  app.setGlobalPrefix(API_PREFIX);
  app.use(helmet());
  // This application uses Nest's Express adapter in production and tests.
  const http = app as NestExpressApplication;
  const config = app.get(AppConfig);
  http.set('trust proxy', config.get('TRUST_PROXY') === 'loopback' ? 'loopback' : false);
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  http.useBodyParser('json', { limit: '16kb' });
  http.useBodyParser('urlencoded', { limit: '16kb', extended: false, parameterLimit: 32 });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ProblemDetailsFilter());

  serveOpenApi(app, buildOpenApiDocument(app, API_VERSION), config.openApiUi);
  return app;
}

/** Creates and configures the application without listening (main.ts, OpenAPI generator). */
export async function createApp(): Promise<INestApplication> {
  return configureApp(await NestFactory.create(AppModule, { bufferLogs: true }));
}
