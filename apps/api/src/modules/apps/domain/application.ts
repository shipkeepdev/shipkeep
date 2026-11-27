import { type ShipkeepConfig, validateShipkeepConfig } from '@shipkeep/config-schema';
import { ConflictError, InvalidInputError } from '@shipkeep/domain';

import { type NodeStatus, observedStatus } from '../../fleet/domain/node';
import { canonicalIpAddress } from '../../fleet/domain/node-address';

/**
 * Sources the control plane can deploy today: an image named in the stored configuration, or a
 * GitHub repository whose shipkeep.yml holds the configuration (M3.1). `compose` arrives with M3.8.
 */
export const APPLICATION_SOURCES = ['image', 'git'] as const;
export type ApplicationSource = (typeof APPLICATION_SOURCES)[number];

/**
 * Where a Git application's configuration lives (ADR 0031, SPEC 4): a repository that an
 * installation of the organization's GitHub App reaches, a branch, and the path of shipkeep.yml.
 * GitHub's identifiers are what the control plane trusts; the name is kept for its calls and for
 * display, and is refreshed when GitHub reports a rename.
 */
export interface ApplicationRepository {
  readonly installationId: number;
  readonly repositoryId: number;
  /** `owner/name`, as GitHub names it. */
  readonly fullName: string;
  readonly branch: string;
  readonly configPath: string;
  /** The commit the configuration was last read from: a release of it records the same. */
  readonly commitSha: string;
}

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
  /** With source `git` only. */
  readonly repository: ApplicationRepository | null;
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
 * What the schema describes but no deployment applies yet (SPEC 2.2). Each is refused rather than
 * ignored, so that a configuration never says something Shipkeep does not do: a volume that is not
 * mounted loses what the application writes there at its next deployment. Leaving a field out, or
 * saying what is already done (an empty list, `previews.enabled: false`, `strategy: rolling`), is
 * accepted.
 */
const UNAPPLIED: readonly {
  readonly field: string;
  readonly what: string;
  readonly why: string;
  readonly present: (config: ShipkeepConfig) => boolean;
}[] = [
  {
    field: '/volumes',
    what: 'volumes',
    why: 'nothing would be mounted, and what the application writes there would be lost at its next deployment.',
    present: (config) => (config.volumes?.length ?? 0) > 0,
  },
  {
    field: '/databases',
    what: 'databases',
    why: 'managed databases are planned.',
    present: (config) => (config.databases?.length ?? 0) > 0,
  },
  {
    field: '/previews',
    what: 'previews',
    why: 'preview environments are planned. Leave previews out, or set enabled: false.',
    present: (config) => config.previews !== undefined && config.previews.enabled !== false,
  },
  {
    field: '/deploy/strategy',
    what: 'deploy.strategy: recreate',
    why: 'every deployment starts the new replicas before it stops the previous ones (rolling).',
    present: (config) => config.deploy?.strategy === 'recreate',
  },
  {
    field: '/deploy/keep_images',
    what: 'deploy.keep_images',
    why: 'servers do not remove old images yet.',
    present: (config) => config.deploy?.keep_images !== undefined,
  },
];

/** Refuses a configuration that uses a field no deployment applies yet (`UNAPPLIED`). */
export function assertConfigApplied(config: ShipkeepConfig): void {
  const unapplied = UNAPPLIED.find((field) => field.present(config));
  if (unapplied !== undefined)
    throw new InvalidInputError(
      'unsupported_config_field',
      `${unapplied.what} is not supported yet: ${unapplied.why}`,
      { field: unapplied.field },
    );
}

/**
 * Validates a `shipkeep.yml` document (already parsed) for an application, whether it was sent to
 * the API or read from its repository. An application created with an image names a built image
 * (`build.type: image`); one whose configuration is a repository's may also be built from that
 * repository with its Dockerfile (ADR 0030). Railpack and Nixpacks follow. Errors list JSON
 * pointers and schema messages, never input values.
 */
export function applicationConfig(
  value: unknown,
  source: ApplicationSource = 'image',
): ApplicationConfig {
  const result = validateShipkeepConfig(value);
  if (!result.ok)
    throw new InvalidInputError('invalid_application_config', 'The configuration is invalid.', {
      issues: result.issues.slice(0, MAX_REPORTED_ISSUES),
    });
  const config = result.config;
  const type = config.build?.type;
  if (type !== 'image' && !(source === 'git' && type === 'dockerfile'))
    throw source === 'git'
      ? new InvalidInputError(
          'unsupported_build_type',
          'Railpack and Nixpacks builds are not supported yet: build with a Dockerfile (build.type: dockerfile), or set build.type to image with the image your CI builds.',
          { field: '/build/type' },
        )
      : new InvalidInputError(
          'unsupported_application_source',
          'An application created without a repository runs an image (build.type: image): to build one, create the application from its repository.',
        );
  assertConfigApplied(config);
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
  return { name: config.name, source, config, canonical };
}

/**
 * The configuration an application keeps when its environment is cloned (issue #257): the same
 * document without `domains`, which stay with the application that serves them. Secret names are
 * kept, so the copy shows which secrets the new environment still needs.
 */
export function clonedConfig(
  config: ShipkeepConfig,
  source: ApplicationSource = 'image',
): ApplicationConfig {
  const { domains: _domains, ...rest } = config;
  return applicationConfig(rest, source);
}

/** A Git application's configuration is its repository's: the API does not replace it. */
export function assertConfigEditable(application: Pick<Application, 'source'>): void {
  if (application.source === 'git')
    throw new ConflictError(
      'application_config_in_repository',
      "This application's configuration is the shipkeep.yml in its repository: change it there.",
    );
}

/**
 * An application cannot serve the control plane's name (ADR 0021): on the machine that hosts both,
 * the agent keeps that name's route for the control plane, and refuses it to applications too.
 * `reserved` holds the host of `API_PUBLIC_URL`. Wildcards are refused earlier.
 */
export function assertDomainsAvailable(config: ShipkeepConfig, reserved: readonly string[]): void {
  // DNS compares without case, and a name with one final dot is the same absolute name.
  const plain = (name: string) => name.toLowerCase().replace(/\.$/, '');
  const names = reserved.map(plain);
  const taken = config.domains?.find((hostname) => names.includes(plain(hostname)));
  if (taken !== undefined)
    throw new InvalidInputError(
      'domain_reserved',
      "This domain is the control plane's own address and cannot serve an application.",
      { hostname: taken },
    );
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
