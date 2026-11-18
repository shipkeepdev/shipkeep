import { PassThrough } from 'node:stream';

import { OperatorUsageError, parseOperatorCommand, readPassword, USAGE } from './operator';

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

  it('removes a whole character on Backspace, whatever its size in bytes', async () => {
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
