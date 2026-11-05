import type { IncomingMessage } from 'node:http';

import { API_PREFIX } from './constants';

/** Default cap on JSON and form bodies (SPEC 8.1). */
export const DEFAULT_BODY_LIMIT = '16kb';
/**
 * Cap for the few documents that are legitimately larger: secret values (64 KiB before JSON
 * escaping) and application configurations (64 KiB canonical). Escaping can grow a value, so the
 * parser accepts more than the domain limits, which still apply.
 */
export const LARGE_JSON_LIMIT = '256kb';

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ENVIRONMENT = `${API_PREFIX}/organizations/${ID}/projects/${ID}/environments/${ID}`;
const LARGE_JSON_ROUTES = new RegExp(
  `^${ENVIRONMENT}/(?:secrets|applications|applications/${ID}/config)$`,
);
const JSON_MEDIA_TYPE = /^application\/json\s*(?:;|$)/i;

/**
 * Selects the large JSON parser: POST requests with a JSON body to one of the large routes.
 * Every other request falls through to the default 16 KiB parser.
 */
export function acceptsLargeJson(request: IncomingMessage): boolean {
  if (request.method !== 'POST') return false;
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !JSON_MEDIA_TYPE.test(contentType)) return false;
  const path = (request.url ?? '').split('?', 1)[0] ?? '';
  return LARGE_JSON_ROUTES.test(path);
}
