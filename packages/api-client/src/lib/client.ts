import createClient, { type Client, type ClientOptions } from 'openapi-fetch';

import type { paths } from '../gen/openapi.js';

/** Media type of error responses (RFC 9457). */
export const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/** RFC 9457 problem details as returned by the API. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  requestId?: string;
  errors?: readonly { path: string; message: string }[];
  details?: Readonly<Record<string, unknown>>;
}

export type ShipkeepClient = Client<paths>;

export interface ShipkeepClientOptions extends Omit<ClientOptions, 'baseUrl'> {
  /** Origin of the control plane, for example `https://shipkeep.example.com`. Defaults to same-origin. */
  baseUrl?: string;
  /** API token sent as a bearer credential. Omit when relying on the session cookie. */
  apiToken?: string;
}

/**
 * Creates a typed client. Paths in the OpenAPI document already include `/api/v1`, so `baseUrl`
 * is the origin only. Session cookies are sent with `credentials: 'include'`.
 */
export function createShipkeepClient(options: ShipkeepClientOptions = {}): ShipkeepClient {
  const { baseUrl = '', apiToken, headers, ...rest } = options;
  return createClient<paths>({
    baseUrl,
    credentials: 'include',
    ...rest,
    headers: {
      accept: 'application/json',
      ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
      ...normalizeHeaders(headers),
    },
  });
}

/** Type guard for a problem details body. */
export function isProblemDetails(value: unknown): value is ProblemDetails {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { status?: unknown }).status === 'number' &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function normalizeHeaders(headers: ClientOptions['headers']): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) =>
      value === undefined || value === null ? [] : [[key, String(value)]],
    ),
  );
}
