import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

import { API_PREFIX } from '../http/constants';

/** Path of the machine-readable document (SPEC section 8). */
export const OPENAPI_JSON_PATH = `${API_PREFIX}/openapi.json`;
/** Path of the interactive UI, served only when enabled by configuration. */
export const OPENAPI_UI_PATH = `${API_PREFIX}/docs`;

export const SESSION_COOKIE = 'shipkeep_session';

export function buildOpenApiDocument(app: INestApplication, version: string): OpenAPIObject {
  const config = new DocumentBuilder()
    .setOpenAPIVersion('3.1.0')
    .setTitle('Shipkeep API')
    .setDescription(
      'Public REST API of the Shipkeep control plane. Errors are RFC 9457 problem details.',
    )
    .setVersion(version)
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', description: 'API token (Authorization: Bearer <token>)' },
      'apiToken',
    )
    .addCookieAuth(
      SESSION_COOKIE,
      { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
      'session',
    )
    .build();
  return SwaggerModule.createDocument(app, config, {
    operationIdFactory: (_controller: string, method: string) => method,
  });
}

export function serveOpenApi(app: INestApplication, document: OpenAPIObject, ui: boolean): void {
  SwaggerModule.setup(OPENAPI_UI_PATH, app, document, {
    jsonDocumentUrl: OPENAPI_JSON_PATH,
    // The UI is a convenience for developers; the JSON document is the contract.
    swaggerUiEnabled: ui,
  });
}
