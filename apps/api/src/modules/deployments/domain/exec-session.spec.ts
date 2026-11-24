import { InvalidInputError } from '@shipkeep/domain';
import { describe, expect, it } from 'vitest';

import { auditedCommand, EXEC_ARG_BYTES, EXEC_ARGS, execRequest, validArgv } from './exec-session';

describe('exec session requests (SPEC 3.3)', () => {
  it('opens a shell in the first replica for 30 minutes by default', () => {
    expect(execRequest({})).toEqual({ replica: 1, argv: ['sh'], tty: true, minutes: 30 });
  });

  it('keeps what the caller chose', () => {
    expect(
      execRequest({ replica: 2, argv: ['bin/rails', 'console'], tty: false, minutes: 240 }),
    ).toEqual({ replica: 2, argv: ['bin/rails', 'console'], tty: false, minutes: 240 });
  });

  it.each([
    ['replica', { replica: 0 }],
    ['replica', { replica: 1.5 }],
    ['replica', { replica: 1001 }],
    ['minutes', { minutes: 0 }],
    ['minutes', { minutes: 241 }],
    ['minutes', { minutes: 2.5 }],
    ['argv', { argv: [] }],
    ['argv', { argv: ['ls', ''] }],
    ['argv', { argv: ['cat', '/etc/passwd\u0000x'] }],
    ['argv', { argv: ['echo', '\uD800'] }],
    ['argv', { argv: Array.from({ length: EXEC_ARGS + 1 }, () => 'x') }],
    ['argv', { argv: ['a'.repeat(EXEC_ARG_BYTES + 1)] }],
    ['argv', { argv: ['é'.repeat(EXEC_ARG_BYTES / 2 + 1)] }],
    ['argv', { argv: Array.from({ length: 5 }, () => 'a'.repeat(EXEC_ARG_BYTES)) }],
  ])('refuses an invalid %s', (field, input) => {
    expect(() => execRequest(input)).toThrow(InvalidInputError);
    try {
      execRequest(input);
    } catch (error) {
      expect((error as InvalidInputError).details).toEqual({ field });
    }
  });

  it('counts bytes, not characters, and accepts surrogate pairs', () => {
    expect(validArgv(['echo', '🙂'])).toBe(true);
    expect(validArgv(['a'.repeat(EXEC_ARG_BYTES)])).toBe(true);
    expect(validArgv(['$(id)', '; rm -rf /'])).toBe(true);
  });

  it('records the program and the number of arguments, never the arguments', () => {
    expect(auditedCommand(['psql', '-W', 'secret-password'])).toEqual({
      program: 'psql',
      arguments: 2,
    });
    expect(JSON.stringify(auditedCommand(['sh', '-c', 'echo hunter2']))).not.toContain('hunter2');
  });
});
