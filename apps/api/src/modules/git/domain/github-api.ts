import { Secret } from '@shipkeep/domain';

/** At most this many repositories are listed for an organization: pages of 100, five each. */
export const MAX_LISTED_REPOSITORIES = 500;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;

/** A repository an installation can reach. */
export interface GithubRepository {
  readonly installationId: number;
  readonly id: number;
  /** `owner/name`. */
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
}

/** What an installation token may do: what a call needs, nothing more (ADR 0031). */
export interface TokenScope {
  readonly repositoryIds?: readonly number[];
  readonly permissions: Readonly<Record<string, 'read' | 'write'>>;
}

/** The App's JWT claims (GitHub: at most ten minutes, issued a minute back for clock drift). */
export function appJwtClaims(appId: number, now: Date): { iat: number; exp: number; iss: string } {
  const seconds = Math.floor(now.getTime() / 1000);
  return { iat: seconds - 60, exp: seconds + 9 * 60, iss: String(appId) };
}

/** An installation token GitHub answered, or undefined when the answer cannot be one. */
export function installationTokenOf(raw: unknown): { token: Secret; expiresAt: Date } | undefined {
  const value = record(raw);
  const token = value?.['token'];
  const expiresAt =
    typeof value?.['expires_at'] === 'string' ? new Date(value['expires_at']) : null;
  if (
    typeof token !== 'string' ||
    !TOKEN.test(token) ||
    !expiresAt ||
    !Number.isFinite(expiresAt.getTime())
  )
    return undefined;
  return { token: new Secret(token), expiresAt };
}

/**
 * One page of an installation's repositories, or undefined when the page is not one. An entry
 * whose names Git or GitHub could not have given is left out, not the page.
 */
export function repositoryPageOf(
  raw: unknown,
  installationId: number,
): { total: number; repositories: GithubRepository[] } | undefined {
  const value = record(raw);
  const total = value?.['total_count'];
  const list = value?.['repositories'];
  if (
    typeof total !== 'number' ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Array.isArray(list)
  )
    return undefined;
  const repositories: GithubRepository[] = [];
  for (const item of list as unknown[]) {
    const repository = repositoryOf(item, installationId);
    if (repository) repositories.push(repository);
  }
  return { total, repositories };
}

/** A repository as GitHub describes it, or undefined when its names or identifier are not valid. */
export function repositoryOf(raw: unknown, installationId: number): GithubRepository | undefined {
  const repository = record(raw);
  const id = repository?.['id'];
  const fullName = repository?.['full_name'];
  const defaultBranch = repository?.['default_branch'];
  const isPrivate = repository?.['private'];
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof fullName !== 'string' ||
    !validFullName(fullName) ||
    typeof defaultBranch !== 'string' ||
    !validBranch(defaultBranch) ||
    typeof isPrivate !== 'boolean'
  )
    return undefined;
  return { installationId, id, fullName, defaultBranch, private: isPrivate };
}

/** A full commit hash, as GitHub names commits. */
export function validCommit(sha: string): boolean {
  return SHA.test(sha);
}

/**
 * Where shipkeep.yml is in a repository: a relative path of at most 255 bytes, ending in `.yml` or
 * `.yaml`, without an empty, `.` or `..` segment, a backslash or a control character. A URL built
 * from it then names that file and nothing else.
 */
export function validConfigPath(path: string): boolean {
  return (
    path.length >= 1 &&
    new TextEncoder().encode(path).length <= 255 &&
    /\.ya?ml$/.test(path) &&
    // eslint-disable-next-line no-control-regex -- control characters are what is refused
    !/[\u0000-\u001f\u007f\\]/.test(path) &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

/** The commit a branch points to, or undefined. */
export function branchHeadOf(raw: unknown): string | undefined {
  const sha = record(record(raw)?.['commit'])?.['sha'];
  return typeof sha === 'string' && SHA.test(sha) ? sha : undefined;
}

/** A repository's `owner/name`: GitHub names, and never `.` or `..`, which a URL would resolve. */
export function validFullName(fullName: string): boolean {
  const parts = fullName.split('/');
  if (parts.length !== 2) return false;
  const [owner = '', name = ''] = parts;
  return OWNER.test(owner) && NAME.test(name) && name !== '.' && name !== '..';
}

/**
 * A branch name as Git allows it (`git check-ref-format`): letters of any script, digits and most
 * punctuation, but no control character, space, `~^:?*[\`, `..`, `@{`, empty or dot-led
 * component, leading or trailing `/`, or final `.lock` or `.`.
 */
export function validBranch(branch: string): boolean {
  return (
    branch.length >= 1 &&
    branch.length <= 255 &&
    // eslint-disable-next-line no-control-regex -- control characters are what is refused
    !/[\u0000-\u0020\u007f~^:?*[\\]/.test(branch) &&
    !branch.includes('..') &&
    !branch.includes('@{') &&
    branch !== '@' &&
    !branch.endsWith('.lock') &&
    !branch.endsWith('.') &&
    branch.split('/').every((part) => part.length > 0 && !part.startsWith('.'))
  );
}

/** A repository and a branch, as a request may name them. */
export function validRepository(fullName: string, branch: string): boolean {
  return validFullName(fullName) && validBranch(branch);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
