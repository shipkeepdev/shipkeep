import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
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
 * Creates and configures the application without listening. Shared by main.ts, the OpenAPI
 * generator and the HTTP tests so they all exercise the same pipeline.
 */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  app.setGlobalPrefix(API_PREFIX);
  app.use(helmet());
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ProblemDetailsFilter());

  const config = app.get(AppConfig);
  serveOpenApi(app, buildOpenApiDocument(app, API_VERSION), config.openApiUi);
  return app;
}
