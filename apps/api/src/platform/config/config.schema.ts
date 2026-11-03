import { Secret } from '@shipkeep/domain';
import { z } from 'zod';

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');

const port = z.coerce.number().int().min(1).max(65535);

const httpUrl = z.url({ protocol: /^https?$/ });

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// URL')
  .transform((value) => new Secret(value));

/**
 * Environment variables of the control plane. Parsed once at startup; the process refuses to
 * start when a value is missing or malformed. Values that embed credentials are wrapped in
 * `Secret` so they can never reach a log line (CLAUDE.md, rule 8).
 */
export const configSchema = z.object({
  NODE_ENV: nodeEnv,
  API_PORT: port.default(3000),
  API_PUBLIC_URL: httpUrl.default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Serve the interactive OpenAPI UI at /api/v1/docs. Off by default outside development. */
  OPENAPI_UI: z.stringbool().optional(),
  DATABASE_URL: postgresUrl,
  /** Key-encryption key file for envelope encryption (SPEC section 9). Used from task M2.1b. */
  SHIPKEEP_KEK_FILE: z.string().min(1),
  AGENT_GATEWAY_ADDR: z
    .string()
    .regex(/^[^\s:]+:\d{1,5}$/, 'must be host:port')
    .default('0.0.0.0:7443'),
  VICTORIALOGS_URL: httpUrl.default('http://localhost:9428'),
  VICTORIAMETRICS_URL: httpUrl.default('http://localhost:8428'),
  REGISTRY_URL: httpUrl.default('http://localhost:5000'),
});

export type RawConfig = z.input<typeof configSchema>;
export type ParsedConfig = z.output<typeof configSchema>;

/** Parses and validates raw environment variables. Throws a readable error listing every problem. */
export function parseConfig(env: Record<string, string | undefined>): ParsedConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`invalid configuration: ${problems.join('; ')}`);
  }
  return result.data;
}
