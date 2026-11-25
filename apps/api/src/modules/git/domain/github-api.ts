import { Secret } from '@shipkeep/domain';

/** At most this many repositories are listed for an organization: pages of 100, five each. */
export const MAX_LISTED_REPOSITORIES = 500;

const FULL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}(?<!\/)$/;
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

/** One page of an installation's repositories, or undefined when any entry cannot be one. */
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
    const repository = record(item);
    const id = repository?.['id'];
    const fullName = repository?.['full_name'];
    const defaultBranch = repository?.['default_branch'];
    const isPrivate = repository?.['private'];
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      typeof fullName !== 'string' ||
      !FULL_NAME.test(fullName) ||
      typeof defaultBranch !== 'string' ||
      !BRANCH.test(defaultBranch) ||
      typeof isPrivate !== 'boolean'
    )
      return undefined;
    repositories.push({ installationId, id, fullName, defaultBranch, private: isPrivate });
  }
  return { total, repositories };
}

/** The commit a branch points to, or undefined. */
export function branchHeadOf(raw: unknown): string | undefined {
  const sha = record(record(raw)?.['commit'])?.['sha'];
  return typeof sha === 'string' && SHA.test(sha) ? sha : undefined;
}

/** A repository's `owner/name` and a branch, as a request may name them. */
export function validRepository(fullName: string, branch: string): boolean {
  return FULL_NAME.test(fullName) && BRANCH.test(branch);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
