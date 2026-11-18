import { PassThrough, Writable } from 'node:stream';

import type { INestApplicationContext } from '@nestjs/common';
import { ConflictError, Secret } from '@shipkeep/domain';

import {
  OperatorUsageError,
  parseOperatorCommand,
  readPassword,
  runOperatorCommand,
  runThenClose,
  UNCLEAN_CLOSE,
  USAGE,
  writeLine,
} from './operator';

describe('operator command line', () => {
  it('reads the two account commands and their address', () => {
    expect(parseOperatorCommand(['account', 'create', '--email', 'owner@example.com'])).toEqual({
      action: 'create',
      email: 'owner@example.com',
    });
    expect(
      parseOperatorCommand(['account', 'reset-password', '--email', 'owner@example.com']),
    ).toEqual({ action: 'reset-password', email: 'owner@example.com' });
  });

  it('refuses anything else, without repeating it', () => {
    const hostile = 'x; rm -rf / $(id) `id` sk_test_fake_value';
    for (const argv of [
      [],
      ['account'],
      ['account', 'create'],
      ['account', 'create', '--email'],
      ['account', 'create', '--email', ''],
      ['account', 'create', '--email', 'a@example.com', 'extra'],
      ['account', 'create', '--password', 'never on a command line'],
      ['account', 'delete', '--email', 'a@example.com'],
      ['user', 'create', '--email', 'a@example.com'],
      ['account', hostile, '--email', 'a@example.com'],
      ['account', 'create', '--email', `a@example.com\n--admin`],
      ['account', 'create', '--email', 'x'.repeat(300)],
    ]) {
      const refusal = (() => {
        try {
          return parseOperatorCommand(argv);
        } catch (error: unknown) {
          return error;
        }
      })();
      expect(refusal, JSON.stringify(argv)).toBeInstanceOf(OperatorUsageError);
      expect((refusal as Error).message).toBe(USAGE);
    }
    expect(USAGE).not.toContain('sk_test_fake');
  });

  it('reads the password from its first line only, when it is piped', async () => {
    const piped = (text: string) => {
      const input = new PassThrough();
      input.end(text);
      return readPassword(input, new PassThrough());
    };
    expect((await piped('a passphrase with spaces\n')).expose()).toBe('a passphrase with spaces');
    expect((await piped('first line\r\nsecond line\n')).expose()).toBe('first line');
    expect((await piped('no line end')).expose()).toBe('no line end');
    // Leading and trailing spaces belong to the password.
    expect((await piped('  padded  \n')).expose()).toBe('  padded  ');
  });

  it('refuses an empty or an oversized password line', async () => {
    for (const text of ['', '\n', 'x'.repeat(5000)]) {
      const input = new PassThrough();
      input.end(text);
      await expect(readPassword(input, new PassThrough())).rejects.toThrow(OperatorUsageError);
    }
  });

  /** A terminal as Node presents it: raw mode on request, bytes as they are typed. */
  function terminal() {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      raw: [] as boolean[],
      setRawMode(mode: boolean) {
        input.raw.push(mode);
        return input;
      },
    });
    return input;
  }
  const shown = (output: PassThrough): string => {
    output.end();
    const written: unknown = output.read();
    return Buffer.isBuffer(written) ? written.toString() : '';
  };

  it('reads a typed password without echo, and gives the terminal back', async () => {
    const input = terminal();
    const output = new PassThrough();
    const reading = readPassword(input, output);
    // Typed key by key, ended with Enter (a carriage return in raw mode).
    for (const key of ['a passphrase ', 'typed at ', 'a terminal', '\r']) input.write(key);
    expect((await reading).expose()).toBe('a passphrase typed at a terminal');
    expect(input.raw).toEqual([true, false]);
    const prompt = shown(output);
    expect(prompt).toContain('input hidden');
    expect(prompt).not.toContain('passphrase');
  });

  it('removes one code point on Backspace, whatever its size in bytes', async () => {
    const typed = async (keys: string[]) => {
      const input = terminal();
      const reading = readPassword(input, new PassThrough());
      for (const key of keys) input.write(key);
      return (await reading).expose();
    };
    // One byte, two bytes (é), three (€) and four (an emoji): Backspace takes the character.
    expect(await typed(['a long passphrase!', '\u007f', '?', '\r'])).toBe('a long passphrase?');
    expect(await typed(['a long passphrase', 'é', '\u007f', '\r'])).toBe('a long passphrase');
    expect(await typed(['a long passphrase', '€', '\b', 'x', '\r'])).toBe('a long passphrasex');
    expect(await typed(['a long passphrase', '😀', '\u007f', '\r'])).toBe('a long passphrase');
    // Nothing left to remove is not an error, and what follows is kept.
    expect(await typed(['ab', '\u007f\u007f\u007f', 'a long passphrase', '\r'])).toBe(
      'a long passphrase',
    );
    // What was typed and kept is never a broken character.
    expect(await typed(['passphrase é€😀 kept whole', '\r'])).toBe('passphrase é€😀 kept whole');
    // A base letter and a combining accent are two code points: Backspace takes the accent.
    expect(await typed(['a long passphrase e\u0301', '\u007f', '\r'])).toBe('a long passphrase e');
  });

  it('gives the terminal back when the entry is cancelled', async () => {
    for (const key of ['\u0003', '\u0004']) {
      const input = terminal();
      const output = new PassThrough();
      const reading = readPassword(input, output);
      input.write('half a passphrase');
      input.write(key);
      await expect(reading).rejects.toThrow(OperatorUsageError);
      expect(input.raw).toEqual([true, false]);
      expect(shown(output)).not.toContain('half a passphrase');
    }
  });

  it('never writes the password back', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    input.end('sk_test_fake_operator_password\n');
    await readPassword(input, output);
    output.end();
    const written: unknown = output.read();
    expect(Buffer.isBuffer(written) ? written.toString() : '').not.toContain('sk_test_fake');
  });
});

describe('what the operator command says', () => {
  const password = new Secret('sk_test_fake_operator_password');
  afterEach(() => {
    // Also after a test that failed half-way: the next one must not inherit its clock.
    vi.useRealTimers();
  });
  /** A stream whose reader is gone: every write fails, as a closed pipe does. */
  function closed(): { stream: Writable; heardBy: number[] } {
    const stream = new Writable({
      write(_chunk, _encoding, done) {
        done(new Error('write EPIPE'));
      },
    });
    // How many listeners heard each `error` event: none would be an uncaught exception.
    const heardBy: number[] = [];
    const emit = stream.emit.bind(stream);
    stream.emit = (event: string | symbol, ...values: unknown[]): boolean => {
      if (event !== 'error') return emit(event, ...values);
      heardBy.push(stream.listenerCount('error'));
      return stream.listenerCount('error') > 0 ? emit(event, ...values) : false;
    };
    return { stream, heardBy };
  }
  function lines(output: PassThrough): string {
    const written: unknown = output.read();
    return Buffer.isBuffer(written) ? written.toString() : '';
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  type Create = (email: string, password: Secret) => Promise<{ id: string; email: string }>;
  type Reset = (email: string, password: Secret) => Promise<string>;
  function application(
    accounts: { create?: Create; resetPassword?: Reset },
    close: () => Promise<void> = () => Promise.resolve(),
  ): INestApplicationContext {
    return { get: () => accounts, close } as unknown as INestApplicationContext;
  }

  it('hears the failure of a write, which would otherwise end the process', async () => {
    const { stream, heardBy } = closed();
    await expect(writeLine(stream, 'a line')).rejects.toThrow('write EPIPE');
    await tick();
    expect(heardBy).toEqual([1]);
    // A write that works leaves no listener behind.
    const open = new PassThrough();
    await writeLine(open, 'a line');
    expect(open.listenerCount('error')).toBe(0);
    expect(lines(open)).toBe('a line\n');
  });

  it('writes one line that says what was done, never the password', async () => {
    const output = new PassThrough();
    const errors = new PassThrough();
    const create = vi.fn<Create>().mockResolvedValue({ id: 'fixture', email: 'owner@example.com' });
    const resetPassword = vi.fn<Reset>().mockResolvedValue('second@example.com');
    await runOperatorCommand(
      application({ create }),
      { action: 'create', email: 'Owner@example.com' },
      password,
      output,
      errors,
    );
    await runOperatorCommand(
      application({ resetPassword }),
      { action: 'reset-password', email: 'second@example.com' },
      password,
      output,
      errors,
    );
    // Each command reaches the service with its own address, as typed, and the password read.
    expect(create.mock.calls).toEqual([['Owner@example.com', password]]);
    expect(create.mock.calls.at(0)?.at(1)).toBe(password);
    expect(resetPassword.mock.calls).toEqual([['second@example.com', password]]);
    expect(resetPassword.mock.calls.at(0)?.at(1)).toBe(password);
    // The line names the account the service changed, not what was typed.
    expect(lines(output)).toBe(
      'Account created: owner@example.com\n' +
        'Password reset: second@example.com. Its sessions and API tokens no longer work.\n',
    );
    expect(lines(errors)).toBe('');
  });

  it('keeps the result of the command when the application does not close cleanly', async () => {
    const failing = () =>
      Promise.reject(new Error('disconnect failed: postgres://user:fixture@db'));
    // A committed change stays a success, with a warning that does not repeat the cause.
    const output = new PassThrough();
    const errors = new PassThrough();
    await expect(
      runThenClose(
        application({ resetPassword: () => Promise.resolve('owner@example.com') }, failing),
        { action: 'reset-password', email: 'owner@example.com' },
        password,
        output,
        errors,
      ),
    ).resolves.toBeUndefined();
    expect(lines(output)).toBe(
      'Password reset: owner@example.com. Its sessions and API tokens no longer work.\n',
    );
    expect(lines(errors)).toBe(`${UNCLEAN_CLOSE}\n`);
    // A refusal stays that refusal: the application is still closed, the close failure does not
    // take its place, and no warning is put before the reason the operator needs.
    const refusal = new ConflictError(
      'account_exists',
      'An account with this address already exists.',
    );
    const closeAfterRefusal = vi.fn(failing);
    const refusedOutput = new PassThrough();
    const refusedErrors = new PassThrough();
    await expect(
      runThenClose(
        application({ create: () => Promise.reject(refusal) }, closeAfterRefusal),
        { action: 'create', email: 'owner@example.com' },
        password,
        refusedOutput,
        refusedErrors,
      ),
    ).rejects.toBe(refusal);
    expect(closeAfterRefusal).toHaveBeenCalledTimes(1);
    expect(lines(refusedOutput) + lines(refusedErrors)).toBe('');
    // The warning itself may have nowhere to go: still the command's result.
    await expect(
      runThenClose(
        application({ resetPassword: () => Promise.resolve('owner@example.com') }, failing),
        { action: 'reset-password', email: 'owner@example.com' },
        password,
        new PassThrough(),
        closed().stream,
      ),
    ).resolves.toBeUndefined();
    // A clean close is called once and says nothing.
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const quiet = new PassThrough();
    await runThenClose(
      application({ resetPassword: () => Promise.resolve('owner@example.com') }, close),
      { action: 'reset-password', email: 'owner@example.com' },
      password,
      new PassThrough(),
      quiet,
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(lines(quiet)).toBe('');
  });

  it('never lets the warning hold the result back when its stream does not drain', async () => {
    vi.useFakeTimers();
    // A reader that stopped reading: the write is accepted and never completes.
    const stalled = new Writable({ write: () => undefined });
    const failing = () => Promise.reject(new Error('disconnect failed'));
    let result: 'pending' | 'done' = 'pending';
    const running = runThenClose(
      application({ resetPassword: () => Promise.resolve('owner@example.com') }, failing),
      { action: 'reset-password', email: 'owner@example.com' },
      password,
      new PassThrough(),
      stalled,
    ).then(() => {
      result = 'done';
    });
    // Two seconds, as SPEC 8 says: written here as numbers, so that a change of the limit in the
    // code alone fails this test.
    await vi.advanceTimersByTimeAsync(1999);
    expect(result).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(result).toBe('done');
    // A warning that leaves at once keeps no timer.
    await runThenClose(
      application({ resetPassword: () => Promise.resolve('owner@example.com') }, failing),
      { action: 'reset-password', email: 'owner@example.com' },
      password,
      new PassThrough(),
      new PassThrough(),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still says a committed change when its output is closed, and succeeds', async () => {
    // The password is changed by the time the line is written: a failure here would be a lie.
    const { stream, heardBy } = closed();
    const errors = new PassThrough();
    await expect(
      runOperatorCommand(
        application({ resetPassword: () => Promise.resolve('owner@example.com') }),
        { action: 'reset-password', email: 'owner@example.com' },
        password,
        stream,
        errors,
      ),
    ).resolves.toBeUndefined();
    await tick();
    expect(lines(errors)).toBe(
      'Password reset: owner@example.com. Its sessions and API tokens no longer work.\n',
    );
    expect(heardBy).toEqual([1]);
    // Both streams closed: nothing can be said, and the change is still not a failure.
    const other = closed();
    await expect(
      runOperatorCommand(
        application({ create: () => Promise.resolve({ id: 'fixture', email: 'o@example.com' }) }),
        { action: 'create', email: 'o@example.com' },
        password,
        closed().stream,
        other.stream,
      ),
    ).resolves.toBeUndefined();
    await tick();
    expect(other.heardBy).toEqual([1]);
  });

  it('writes nothing when the command is refused: the refusal is the result', async () => {
    const output = new PassThrough();
    const errors = new PassThrough();
    await expect(
      runOperatorCommand(
        application({
          create: () =>
            Promise.reject(
              new ConflictError('account_exists', 'An account with this address already exists.'),
            ),
        }),
        { action: 'create', email: 'owner@example.com' },
        password,
        output,
        errors,
      ),
    ).rejects.toThrow('An account with this address already exists.');
    expect(lines(output) + lines(errors)).toBe('');
  });
});
