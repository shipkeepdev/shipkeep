import { type ShipkeepConfig, validateShipkeepConfig } from '@shipkeep/config-schema';
import { InvalidInputError } from '@shipkeep/domain';

/** Sources the control plane can deploy today; `git` and `compose` arrive with M3.1 and M3.8. */
export const APPLICATION_SOURCES = ['image'] as const;
export type ApplicationSource = (typeof APPLICATION_SOURCES)[number];

/** Largest stored configuration, as canonical JSON. Matches the agent-bound action size budget. */
export const MAX_APPLICATION_CONFIG_BYTES = 64 * 1024;
const MAX_REPORTED_ISSUES = 20;

export interface ApplicationTarget {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

export interface Application extends ApplicationTarget {
  readonly id: string;
  readonly name: string;
  readonly source: ApplicationSource;
  readonly config: ShipkeepConfig;
  /** SHA-256 of the canonical JSON configuration, lower-case hex. */
  readonly configSha: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A validated configuration for an image application, with its canonical serialization. */
export interface ApplicationConfig {
  readonly name: string;
  readonly source: ApplicationSource;
  readonly config: ShipkeepConfig;
  readonly canonical: string;
}

/**
 * Validates a `shipkeep.yml` document (already parsed) for an application created through the API.
 * Only image sources are accepted until git and Compose sources land; the image reference itself
 * is checked by the schema. Errors list JSON pointers and schema messages, never input values.
 */
export function applicationConfig(value: unknown): ApplicationConfig {
  const result = validateShipkeepConfig(value);
  if (!result.ok)
    throw new InvalidInputError('invalid_application_config', 'The configuration is invalid.', {
      issues: result.issues.slice(0, MAX_REPORTED_ISSUES),
    });
  const config = result.config;
  if (config.build?.type !== 'image')
    throw new InvalidInputError(
      'unsupported_application_source',
      'Only image applications (build.type: image) can be created for now.',
    );
  // Wildcards need DNS-01 (SPEC 2.2), which neither the agent nor the control plane offers yet.
  if (config.domains?.some((hostname) => hostname.startsWith('*.')))
    throw new InvalidInputError(
      'wildcard_domain_unsupported',
      'Wildcard domains are not supported yet.',
    );
  const canonical = canonicalJson(config);
  if (new TextEncoder().encode(canonical).length > MAX_APPLICATION_CONFIG_BYTES)
    throw new InvalidInputError(
      'application_config_too_large',
      `The configuration exceeds ${String(MAX_APPLICATION_CONFIG_BYTES)} bytes.`,
    );
  return { name: config.name, source: 'image', config, canonical };
}

/** A configuration update may change anything but the name, which identifies the application. */
export function assertSameName(
  application: Pick<Application, 'name'>,
  next: ApplicationConfig,
): void {
  if (application.name !== next.name)
    throw new InvalidInputError(
      'application_name_immutable',
      'The configuration name must match the application name.',
    );
}

/** JSON with object keys sorted recursively, so equal configurations hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  return value;
}

/** Where a domain points, as far as the control plane may say (SPEC 8, PLAN M3.6a). */
export type DomainDnsStatus = 'public' | 'private' | 'none' | 'unknown';

export interface DomainDns {
  readonly hostname: string;
  readonly status: DomainDnsStatus;
  /** Public addresses only: answers about internal names must not reach tenants. */
  readonly addresses: readonly string[];
}

/** `addresses` undefined means the lookup itself failed, which says nothing about the record. */
export function domainDns(
  hostname: string,
  addresses: readonly string[] | undefined,
  isPublic: (address: string) => boolean,
): DomainDns {
  if (!addresses) return { hostname, status: 'unknown', addresses: [] };
  if (!addresses.length) return { hostname, status: 'none', addresses: [] };
  const visible = addresses.filter(isPublic);
  return { hostname, status: visible.length ? 'public' : 'private', addresses: visible };
}
