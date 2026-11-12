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
export const configSchema = z
  .object({
    NODE_ENV: nodeEnv,
    API_PORT: port.default(3000),
    TRUST_PROXY: z.enum(['none', 'loopback']).default('none'),
    API_PUBLIC_URL: httpUrl
      .refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
      }, 'must be an origin without credentials, path, query or fragment')
      .default('http://localhost:3000'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    /** Serve the interactive OpenAPI UI at /api/v1/docs. Off by default outside development. */
    OPENAPI_UI: z.stringbool().optional(),
    /** Built browser files; defaults to dist/apps/web/browser in production only. */
    WEB_DIST_DIR: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes(String.fromCharCode(0)))
      .optional(),
    DATABASE_URL: postgresUrl,
    /** Key-encryption key file for envelope encryption (SPEC section 9). Used from task M2.1b. */
    SHIPKEEP_KEK_FILE: z.string().min(1),
    AGENT_GATEWAY_ADDR: z
      .string()
      .regex(/^[^\s:]+:\d{1,5}$/, 'must be host:port')
      .refine((value) => Number(value.split(':')[1]) <= 65535, 'port must be at most 65535')
      .default('0.0.0.0:7443'),
    AGENT_GATEWAY_SERVER_NAME: z.union([z.hostname(), z.ipv4(), z.ipv6()]).default('localhost'),
    VICTORIALOGS_URL: httpUrl.default('http://localhost:9428'),
    VICTORIAMETRICS_URL: httpUrl.default('http://localhost:8428'),
    REGISTRY_URL: httpUrl.default('http://localhost:5000'),
    SMTP_HOST: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9.:-]+$/)
      .optional(),
    SMTP_PORT: port.default(465),
    SMTP_FROM: z.email().max(254).optional(),
    SMTP_USER: z.string().min(1).max(254).optional(),
    SMTP_PASSWORD: z
      .string()
      .min(1)
      .max(4096)
      .transform((value) => new Secret(value))
      .optional(),
    SMTP_CA_FILE: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production' && new URL(value.API_PUBLIC_URL).protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        path: ['API_PUBLIC_URL'],
        message: 'must use HTTPS in production',
      });
    }
    if (value.SMTP_HOST && !value.SMTP_FROM)
      context.addIssue({
        code: 'custom',
        path: ['SMTP_FROM'],
        message: 'required when SMTP_HOST is configured',
      });
    if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASSWORD))
      context.addIssue({
        code: 'custom',
        path: ['SMTP_PASSWORD'],
        message: 'SMTP_USER and SMTP_PASSWORD must be configured together',
      });
  });

export type RawConfig = z.input<typeof configSchema>;
export type ParsedConfig = z.output<typeof configSchema>;

/**
 * Parses and validates raw environment variables. Throws a readable error listing every problem.
 * An empty value counts as unset: a compose file cannot omit a variable, it can only leave it empty.
 */
export function parseConfig(env: Record<string, string | undefined>): ParsedConfig {
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const result = configSchema.safeParse(set);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`invalid configuration: ${problems.join('; ')}`);
  }
  return result.data;
}
