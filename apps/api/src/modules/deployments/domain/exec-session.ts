import { InvalidInputError } from '@shipkeep/domain';

/**
 * An interactive exec session in one replica of an application (SPEC 3.1, 3.3; M6.1). The bounds
 * are the agent's own, checked here first so that a refusal names its reason.
 */
export const EXEC_ARGS = 64;
export const EXEC_ARG_BYTES = 4096;
/** The API's own bound: the agent accepts 16 KiB in all, and a request body is at most 16 KiB. */
export const EXEC_ARGV_BYTES = 8192;
export const EXEC_MINUTES = { min: 1, max: 240, default: 30 } as const;
/** How long the browser and the agent have to join an opened session. */
export const EXEC_ATTACH_MS = 60_000;
/** A replica last seen longer ago than this may be gone: no session opens in it. */
export const EXEC_FRESH_MS = 2 * 60_000;
/** Sessions one person, and one organization, may have waiting or open at once. */
export const EXEC_SESSIONS_PER_USER = 4;
export const EXEC_SESSIONS_PER_ORGANIZATION = 32;
/** What a session runs when the caller names nothing. */
export const DEFAULT_ARGV: readonly string[] = ['sh'];

export interface ExecRequest {
  readonly replica: number;
  readonly argv: readonly string[];
  readonly tty: boolean;
  readonly minutes: number;
}

/** The request with its defaults, or `exec_request_invalid` with the field at fault. */
export function execRequest(input: {
  replica?: number | undefined;
  argv?: readonly string[] | undefined;
  tty?: boolean | undefined;
  minutes?: number | undefined;
}): ExecRequest {
  // Replicas are numbered from 0, as allocations and their containers are.
  const replica = input.replica ?? 0;
  if (!Number.isInteger(replica) || replica < 0 || replica > 999) invalid('replica');
  const argv = input.argv ?? DEFAULT_ARGV;
  if (!validArgv(argv)) invalid('argv');
  const minutes = input.minutes ?? EXEC_MINUTES.default;
  if (!Number.isInteger(minutes) || minutes < EXEC_MINUTES.min || minutes > EXEC_MINUTES.max) {
    invalid('minutes');
  }
  return { replica, argv: [...argv], tty: input.tty ?? true, minutes };
}

/** 1 to 64 non-empty entries without NUL, each at most 4 KiB, 16 KiB in all, in UTF-8. */
export function validArgv(argv: readonly string[]): boolean {
  if (argv.length === 0 || argv.length > EXEC_ARGS) return false;
  let total = 0;
  for (const arg of argv) {
    const bytes = new TextEncoder().encode(arg).length;
    total += bytes;
    if (arg === '' || bytes > EXEC_ARG_BYTES || arg.includes('\u0000') || !wellFormed(arg)) {
      return false;
    }
  }
  return total <= EXEC_ARGV_BYTES;
}

/**
 * A string without lone surrogates, which UTF-8 cannot carry. With the `u` flag a surrogate pair
 * is one code point, so only a lone surrogate matches the range.
 */
function wellFormed(value: string): boolean {
  return !/[\uD800-\uDFFF]/u.test(value);
}

/**
 * What the audit log keeps of a command: the program and how many arguments it had. Arguments
 * can carry what the person typed, a password included, so they are never recorded.
 */
export function auditedCommand(argv: readonly string[]): { program: string; arguments: number } {
  // Cut by code points: half of a surrogate pair is not valid in the audit log's JSON.
  const program = Array.from(argv[0] ?? '')
    .slice(0, 256)
    .join('');
  return { program, arguments: Math.max(argv.length - 1, 0) };
}

function invalid(field: string): never {
  throw new InvalidInputError('exec_request_invalid', `Invalid exec session: ${field}.`, {
    field,
  });
}
