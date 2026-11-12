import { type ShipkeepConfig, validateShipkeepConfig } from '@shipkeep/config-schema';
import { InvalidInputError } from '@shipkeep/domain';

import { type NodeStatus, observedStatus } from '../../fleet/domain/node';
import { canonicalIpAddress } from '../../fleet/domain/node-address';

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

/**
 * Whether a domain's answers reach a node running the application (PLAN M3.6b1):
 * - `serving`: every answer is a declared public address of such a node;
 * - `partial`: some answers are, others are not;
 * - `elsewhere`: no answer is, or there is no record;
 * - `not_running`: no reachable node runs the application, so no answer can reach it;
 * - `unknown`: the lookup failed, or a running node has no declared address to compare with.
 */
export type DomainMatch = 'serving' | 'partial' | 'elsewhere' | 'not_running' | 'unknown';

/** A node with a placed replica of the application that its agent last saw running. */
export interface ApplicationHost {
  readonly status: NodeStatus;
  readonly lastHeartbeatAt: Date | null;
  /** Canonical addresses declared by an administrator; empty when none is. */
  readonly publicAddresses: readonly string[];
}

export interface DomainDns {
  readonly hostname: string;
  readonly status: DomainDnsStatus;
  /** Public addresses only: answers about internal names must not reach tenants. */
  readonly addresses: readonly string[];
  /** Says whether the domain reaches the application, never which node addresses were compared. */
  readonly match: DomainMatch;
}

/** `addresses` undefined means the lookup itself failed, which says nothing about the record. */
export function domainDns(
  hostname: string,
  addresses: readonly string[] | undefined,
  isPublic: (address: string) => boolean,
  hosts: readonly ApplicationHost[],
  now: Date,
): DomainDns {
  const match = domainMatch(addresses, hosts, now);
  if (!addresses) return { hostname, status: 'unknown', addresses: [], match };
  if (!addresses.length) return { hostname, status: 'none', addresses: [], match };
  const visible = addresses.filter(isPublic);
  return { hostname, status: visible.length ? 'public' : 'private', addresses: visible, match };
}

/**
 * Compares every answer, private ones included (they can never equal a declared public address),
 * with the addresses of the nodes running the application. A node whose lease expired or that was
 * removed no longer counts, even if its last report said the replica was running.
 */
export function domainMatch(
  answers: readonly string[] | undefined,
  hosts: readonly ApplicationHost[],
  now: Date,
): DomainMatch {
  const serving = hosts.filter((host) => {
    const status = observedStatus(host, now);
    return status !== 'down' && status !== 'removed';
  });
  if (!serving.length) return 'not_running';
  if (!answers) return 'unknown';
  if (!answers.length) return 'elsewhere';
  const declared = new Set(serving.flatMap((host) => host.publicAddresses));
  const matched = answers.filter((answer) => {
    const canonical = canonicalIpAddress(answer);
    return canonical !== undefined && declared.has(canonical);
  }).length;
  if (matched === answers.length) return 'serving';
  // An unmatched answer may be the address of a running node nobody declared.
  if (serving.some((host) => !host.publicAddresses.length)) return 'unknown';
  return matched ? 'partial' : 'elsewhere';
}
