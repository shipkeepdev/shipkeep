// Control plane entry point.
//
// SHIPKEEP_OPENAPI_OUT=<file> writes the OpenAPI document to that file and exits without
// listening; `pnpm gen:openapi` uses it to keep apps/api/openapi.json and the generated client
// in sync (CLAUDE.md, rule 9).

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Logger } from 'nestjs-pino';

import { createApp } from './bootstrap';
import { AppConfig } from './platform/config/app-config';
import { API_VERSION } from './platform/health/health.controller';
import { API_PREFIX } from './platform/http/constants';
import { installWebApp } from './platform/http/web-app';
import { buildOpenApiDocument, OPENAPI_JSON_PATH } from './platform/openapi/openapi';

async function main(): Promise<void> {
  const app = await createApp();
  const logger = app.get(Logger);

  const openApiOut = process.env['SHIPKEEP_OPENAPI_OUT'];
  if (openApiOut) {
    // No app.init(): lifecycle hooks (database connection) must not run in document-only mode.
    const document = buildOpenApiDocument(app, API_VERSION);
    await writeFile(openApiOut, `${JSON.stringify(document, null, 2)}\n`);
    return;
  }

  const config = app.get(AppConfig);
  const webDirectory =
    config.get('WEB_DIST_DIR') ??
    (config.isProduction ? resolve('dist/apps/web/browser') : undefined);
  const port = config.get('API_PORT');
  try {
    if (webDirectory) await installWebApp(app, webDirectory);
    await app.listen(port);
  } catch (error: unknown) {
    await app.close();
    throw error;
  }
  logger.log(
    `control plane listening on http://localhost:${String(port)}${API_PREFIX}, OpenAPI at ${OPENAPI_JSON_PATH}`,
  );
}

main().catch((error: unknown) => {
  // The pino logger may not exist yet (configuration errors), so write plainly.
  console.error('control plane failed to start:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
