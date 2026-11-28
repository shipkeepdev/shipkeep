// Control plane entry point.
//
// SHIPKEEP_OPENAPI_OUT=<file> writes the OpenAPI document to that file and exits without
// listening; `pnpm gen:openapi` uses it to keep apps/api/openapi.json and the generated client
// in sync (CLAUDE.md, rule 9).

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Logger } from 'nestjs-pino';

import { NestFactory } from '@nestjs/core';
import { isDomainError } from '@shipkeep/domain';

import { AppModule } from './app.module';
import { createApp } from './bootstrap';
import { AgentGateway } from './modules/fleet/interface/agent-gateway';
import { DeploymentWorker } from './modules/deployments/infrastructure/deployment-worker';
import { ImageRetentionWorker } from './modules/deployments/infrastructure/image-retention-worker';
import { PushWorker } from './modules/deployments/infrastructure/push-worker';
import { ExecSessionChecks } from './modules/fleet/infrastructure/exec-session-checks';
import { AgentUpgradeWorker } from './modules/fleet/infrastructure/agent-upgrade-worker';
import { AppConfig } from './platform/config/app-config';
import { API_VERSION } from './platform/health/health.controller';
import { API_PREFIX } from './platform/http/constants';
import { installWebApp } from './platform/http/web-app';
import { buildOpenApiDocument, OPENAPI_JSON_PATH } from './platform/openapi/openapi';
import {
  needsPassword,
  OperatorUsageError,
  operatorExitCode,
  parseOperatorCommand,
  readPassword,
  runThenClose,
  writeLine,
} from './operator';

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
    // Browser assets must be installed before init() so they sit ahead of Nest's not-found handler.
    if (webDirectory) await installWebApp(app, webDirectory);
    await app.init();
    await app.get(AgentGateway).start();
    await app.get(DeploymentWorker).start();
    await app.get(PushWorker).start();
    await app.get(ImageRetentionWorker).start();
    await app.get(AgentUpgradeWorker).start();
    // Before the API listens: no exec session of this process exists yet (issue #489).
    await app.get(ExecSessionChecks).start();
    await app.listen(port);
  } catch (error: unknown) {
    await app.close();
    throw error;
  }
  logger.log(
    `control plane listening on http://localhost:${String(port)}${API_PREFIX}, OpenAPI at ${OPENAPI_JSON_PATH}`,
  );
}

/**
 * `node main.js account|organization|server ...`: one command of the operator, then exit (ADR 0020,
 * ADR 0021). Nothing listens:
 * no HTTP port, no agent gateway, no deployment worker.
 */
async function operate(argv: readonly string[]): Promise<void> {
  // Read before anything starts: a mistyped command opens no database connection.
  const command = parseOperatorCommand(argv);
  const password = needsPassword(command)
    ? await readPassword(process.stdin, process.stderr)
    : undefined;
  // The application without its HTTP server, and without its startup lines: the command writes
  // one line, which they would bury. Warnings and errors still show.
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  await runThenClose(app, command, password, process.stdout, process.stderr);
}

const operatorArguments = process.argv.slice(2);
if (operatorArguments.length > 0) {
  operate(operatorArguments).then(
    // Standard input may still be open: leave now that the one command is done. Its line was
    // handed over before this runs.
    () => process.exit(0),
    (error: unknown) => {
      // A refusal says why in words meant for people. Anything else stays short: the cause may
      // hold connection details or settings.
      const refused = error instanceof OperatorUsageError || isDomainError(error);
      const message = refused
        ? error.message
        : 'The command failed. Run it with the settings of the control plane, and check that the database answers.';
      const code = operatorExitCode(error);
      // Leave only once the message is handed over: a pipe may take it later than this line.
      void writeLine(process.stderr, message).then(
        () => process.exit(code),
        () => process.exit(code),
      );
    },
  );
} else {
  main().catch((error: unknown) => {
    // The pino logger may not exist yet (configuration errors), so write plainly.
    console.error('control plane failed to start:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
