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
