import { InvalidInputError, type Secret } from '@shipkeep/domain';

/** What the API shows of stored registry credentials: never the password. */
export interface RegistryCredentialMetadata {
  readonly id: string;
  /** Registry host and optional port as image references name it; `docker.io` for Docker Hub. */
  readonly server: string;
  readonly username: string;
  /** Incremented each time the credentials are replaced. */
  readonly version: number;
  readonly updatedBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Credentials as a deployment uses them; the password stays wrapped until the point of use. */
export interface RegistryLogin {
  readonly server: string;
  readonly username: string;
  readonly password: Secret;
}

/** The one name credentials for Docker Hub are stored under. */
export const DOCKER_HUB_SERVER = 'docker.io';
/** How many registries an organization stores credentials for. The list returns them all. */
export const MAX_REGISTRIES = 100;
/** Names people write for Docker Hub, and the host that serves its registry API. */
const DOCKER_HUB_NAMES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

const HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_SERVER = 255;
/** The agent accepts a user name of at most 256 bytes and a password of at most 4096. */
const MAX_USERNAME_BYTES = 256;
const MAX_PASSWORD_BYTES = 4096;
// C0 controls, DEL and C1 controls: nothing a registry issues contains them.
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Normalizes the registry an organization stores credentials for: a host and an optional port,
 * exactly as image references name it, in lower case. A URL, a path or embedded credentials are
 * refused, so the value can never point a request somewhere else. Docker Hub has one name.
 */
export function registryServer(input: string): string {
  const invalid = () =>
    new InvalidInputError(
      'invalid_registry_server',
      'Give the registry as a host name and an optional port, such as ghcr.io.',
    );
  const server = input.trim().toLowerCase();
  if (server.length === 0 || server.length > MAX_SERVER) throw invalid();
  const parts = server.split(':');
  const host = parts[0] ?? '';
  if (parts.length > 2 || !HOST.test(host)) throw invalid();
  if (parts.length === 2) {
    const port = parts[1] ?? '';
    if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) throw invalid();
  }
  return DOCKER_HUB_NAMES.has(server) ? DOCKER_HUB_SERVER : server;
}

export function assertRegistryUsername(username: string): void {
  if (
    username.trim().length === 0 ||
    new TextEncoder().encode(username).length > MAX_USERNAME_BYTES ||
    CONTROL.test(username) ||
    // HTTP Basic authentication separates the user name from the password with a colon.
    username.includes(':')
  )
    throw new InvalidInputError(
      'invalid_registry_username',
      'The user name must have 1 to 256 bytes, no control character and no colon.',
    );
}

/** The message names the rule, never the value. */
export function assertRegistryPassword(password: Secret): void {
  const value = password.expose();
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).length > MAX_PASSWORD_BYTES ||
    CONTROL.test(value)
  )
    throw new InvalidInputError(
      'invalid_registry_password',
      'The password or token must have 1 to 4096 bytes and no control character.',
    );
}
