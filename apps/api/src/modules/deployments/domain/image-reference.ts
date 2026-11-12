import { InvalidInputError } from '@shipkeep/domain';

/** Docker Hub serves its registry API from this host. */
export const DOCKER_HUB_REGISTRY = 'registry-1.docker.io';
/** Names people write for Docker Hub. None of them serves the registry API. */
const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io']);

const COMPONENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** A parsed `shipkeep.yml` image reference (SPEC 2, `build.image`). */
export interface ImageReference {
  /** Registry API host and optional port, for example `ghcr.io` or `registry-1.docker.io`. */
  readonly registry: string;
  /** Repository path inside the registry, for example `library/nginx`. */
  readonly repository: string;
  /**
   * What the agent pulls (`<name>@<digest>`) and what Docker then records for the image: the
   * reference without tag and digest, in Docker's own short form for Docker Hub (`nginx`, not
   * `docker.io/library/nginx`). The agent checks the pulled image against this exact name.
   */
  readonly name: string;
  readonly tag: string | null;
  readonly digest: string | null;
}

/**
 * Parses an image reference with Docker's rules: the first path component is a registry only if it
 * contains a dot or a port, or is `localhost`; otherwise the image lives on Docker Hub, under
 * `library/` when it has a single component. `docker.io` and `index.docker.io` also mean Docker Hub.
 * A reference without tag or digest means `latest`.
 */
export function parseImageReference(reference: string): ImageReference {
  const invalid = () =>
    new InvalidInputError('invalid_image_reference', 'The image reference is invalid.');
  if (reference.length === 0 || reference.length > 512) throw invalid();
  const at = reference.split('@');
  if (at.length > 2) throw invalid();
  const withTag = at[0] ?? '';
  const digest = at.length === 2 ? (at[1] ?? '') : null;
  if (digest !== null && !DIGEST.test(digest)) throw invalid();
  const slash = withTag.lastIndexOf('/');
  const colon = withTag.lastIndexOf(':');
  const tag = colon > slash ? withTag.slice(colon + 1) : null;
  const name = tag === null ? withTag : withTag.slice(0, colon);
  if (tag !== null && !TAG.test(tag)) throw invalid();

  const parts = name.split('/');
  const first = parts[0] ?? '';
  const explicitRegistry = parts.length > 1 && looksLikeHost(first);
  const path = explicitRegistry ? parts.slice(1) : parts;
  if (path.length === 0 || !path.every((component) => COMPONENT.test(component))) throw invalid();
  let registry = DOCKER_HUB_REGISTRY;
  let repository = path.join('/');
  // Docker adds `library/` for Docker Hub written as no host or as one of its aliases only: the
  // repository must stay the one the daemon pulls for the name as written.
  let hub = !explicitRegistry;
  if (explicitRegistry) {
    const hostAndPort = first.split(':');
    if (
      hostAndPort.length > 2 ||
      !HOST.test(hostAndPort[0] ?? '') ||
      (hostAndPort.length === 2 && !validPort(hostAndPort[1] ?? ''))
    )
      throw invalid();
    // `docker.io/nginx` is Docker Hub written out: same host and `library/` rule as `nginx`.
    hub = DOCKER_HUB_ALIASES.has(first);
    if (!hub) registry = first;
  }
  // Docker Hub namespaces hold no dot. Without its host, `docker.io/127.0.0.1/app` would become
  // `127.0.0.1/app`, which Docker reads as a registry: the short name must not name another host.
  if (hub && path.length > 1 && looksLikeHost(path[0] ?? '')) throw invalid();
  if (hub && path.length === 1) repository = `library/${repository}`;
  return {
    registry,
    repository,
    name: hub ? familiarHubName(path) : name,
    tag: tag ?? (digest === null ? 'latest' : null),
    digest,
  };
}

/** Docker's rule for reading the first component of a name as a registry host. */
function looksLikeHost(component: string): boolean {
  return component.includes('.') || component.includes(':') || component === 'localhost';
}

/** Docker Hub repositories are recorded without a host, and official images without `library/`. */
function familiarHubName(path: readonly string[]): string {
  return path.length === 2 && path[0] === 'library' ? (path[1] ?? '') : path.join('/');
}

/** The digest-pinned reference the agent accepts (`PullImage`, `ContainerSpec.image_ref`). */
export function pinnedReference(image: ImageReference, digest: string): string {
  if (!DIGEST.test(digest))
    throw new InvalidInputError('invalid_image_digest', 'The image digest is invalid.');
  return `${image.name}@${digest}`;
}

function validPort(port: string): boolean {
  if (!/^[0-9]{1,5}$/.test(port)) return false;
  const value = Number(port);
  return value >= 1 && value <= 65_535;
}
