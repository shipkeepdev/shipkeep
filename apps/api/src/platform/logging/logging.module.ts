import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { AppConfig } from '../config/app-config';

/** Request and response fields that may carry credentials. Redacted before any line is written. */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-shipkeep-join-token"]',
  'req.headers["x-shipkeep-csrf"]',
  'res.headers["set-cookie"]',
  'req.query.token',
  'req.query.access_token',
];

/** Paths that are not worth a line per request. */
const QUIET_PATHS = new Set(['/api/v1/health', '/api/v1/ready']);

/**
 * Structured JSON request logging (pino). One line per request with a request id, method, URL,
 * status and duration. Bodies are never logged; sensitive headers are redacted.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          base: { component: 'shipkeep-api' },
          timestamp: () => `,"time":"${new Date().toISOString()}"`,
          redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
          genReqId: (req: IncomingMessage) => {
            const incoming = req.headers['x-request-id'];
            return typeof incoming === 'string' && /^[\w.-]{1,128}$/.test(incoming)
              ? incoming
              : randomUUID();
          },
          autoLogging: {
            ignore: (req: IncomingMessage) => QUIET_PATHS.has((req.url ?? '').split('?')[0] ?? ''),
          },
          serializers: {
            req: (req: { id: unknown; method: string; url: string; remoteAddress?: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url,
              remoteAddress: req.remoteAddress,
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
        },
      }),
    }),
  ],
})
export class LoggingModule {}
