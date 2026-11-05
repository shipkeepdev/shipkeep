import { InvalidInputError } from '@shipkeep/domain';

/** Docker Hub serves its registry API from this host. */
export const DOCKER_HUB_REGISTRY = 'registry-1.docker.io';

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
  /** The reference as written without tag and digest; what the agent pulls (`<name>@<digest>`). */
  readonly name: string;
  readonly tag: string | null;
  readonly digest: string | null;
}

/**
 * Parses an image reference with Docker's rules: the first path component is a registry only if it
 * contains a dot or a port, or is `localhost`; otherwise the image lives on Docker Hub, under
 * `library/` when it has a single component. A reference without tag or digest means `latest`.
 */
export function parseImageReference(reference: string): ImageReference {
  const invalid = () =>
    new InvalidInputError('invalid_image_reference', 'The image reference is invalid.');
  if (reference.length === 0 || reference.length > 512) throw invalid();
  const [withTag = '', digest = null, extra] = reference.split('@');
  if (extra !== undefined || (digest !== null && !DIGEST.test(digest))) throw invalid();
  const slash = withTag.lastIndexOf('/');
  const colon = withTag.lastIndexOf(':');
  const tag = colon > slash ? withTag.slice(colon + 1) : null;
  const name = tag === null ? withTag : withTag.slice(0, colon);
  if (tag !== null && !TAG.test(tag)) throw invalid();

  const parts = name.split('/');
  const first = parts[0] ?? '';
  const explicitRegistry =
    parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  const path = explicitRegistry ? parts.slice(1) : parts;
  if (path.length === 0 || !path.every((component) => COMPONENT.test(component))) throw invalid();
  let registry = DOCKER_HUB_REGISTRY;
  let repository = path.join('/');
  if (explicitRegistry) {
    const [host = '', port, more] = first.split(':');
    if (more !== undefined || !HOST.test(host) || (port !== undefined && !validPort(port)))
      throw invalid();
    registry = first;
  } else if (path.length === 1) {
    repository = `library/${repository}`;
  }
  return {
    registry,
    repository,
    name,
    tag: tag ?? (digest === null ? 'latest' : null),
    digest,
  };
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
