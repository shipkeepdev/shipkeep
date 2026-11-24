import { InvalidInputError } from '@shipkeep/domain';

/**
 * An interactive exec session in one replica of an application (SPEC 3.1, 3.3; M6.1). The bounds
 * are the agent's own, checked here first so that a refusal names its reason.
 */
export const EXEC_ARGS = 64;
export const EXEC_ARG_BYTES = 4096;
export const EXEC_ARGV_BYTES = 16384;
export const EXEC_MINUTES = { min: 1, max: 240, default: 30 } as const;
/** How long the browser and the agent have to join an opened session. */
export const EXEC_ATTACH_MS = 60_000;
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
  const replica = input.replica ?? 1;
  if (!Number.isInteger(replica) || replica < 1 || replica > 1000) invalid('replica');
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
  const program = argv[0] ?? '';
  return { program: program.slice(0, 256), arguments: Math.max(argv.length - 1, 0) };
}

function invalid(field: string): never {
  throw new InvalidInputError('exec_request_invalid', `Invalid exec session: ${field}.`, {
    field,
  });
}
