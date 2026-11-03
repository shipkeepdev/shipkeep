// Control plane entry point. Task M2.1 replaces this minimal bootstrap with the real API
// skeleton (config validation, problem-details errors, OpenAPI, request logging).

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app/app.module';

const GLOBAL_PREFIX = 'api';
const DEFAULT_PORT = 3000;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix(GLOBAL_PREFIX);

  const port = Number(process.env['API_PORT'] ?? DEFAULT_PORT);
  await app.listen(port);
  Logger.log(`Control plane API listening on http://localhost:${String(port)}/${GLOBAL_PREFIX}`);
}

bootstrap().catch((error: unknown) => {
  Logger.error(
    'Control plane failed to start',
    error instanceof Error ? error.stack : String(error),
  );
  process.exitCode = 1;
});
