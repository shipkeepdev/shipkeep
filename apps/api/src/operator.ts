// The command line of the control plane, for whoever operates the server (ADR 0020):
//
//   node main.js account create --email <address>
//   node main.js account reset-password --email <address>
//
// The password never comes as an argument or a variable, where other processes could read it: it
// is typed without echo on a terminal, or is the first line of a pipe.

import type { Readable, Writable } from 'node:stream';

import type { INestApplicationContext } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';

import { OperatorAccountCommands } from './modules/identity/application/operator-account-commands';

export const USAGE = [
  'Usage, on the server that runs the control plane:',
  '  node main.js account create --email <address>',
  '  node main.js account reset-password --email <address>',
  'The password is read from standard input: typed without echo on a terminal, or the first line of a pipe.',
].join('\n');

/** A command that cannot be read. Its message is the usage, never what was typed. */
export class OperatorUsageError extends Error {
  constructor(message = USAGE) {
    super(message);
    this.name = 'OperatorUsageError';
  }
}

export interface OperatorCommand {
  readonly action: 'create' | 'reset-password';
  readonly email: string;
}

/** Longest password line accepted: the policy allows 128 characters, of four bytes at most. */
const MAX_PASSWORD_BYTES = 1024;
/** A control character: an address never holds one, and a terminal would act on it. */
const isControl = (character: string): boolean =>
  character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127;

/** Reads the arguments after `node main.js`. The list of commands is closed. */
export function parseOperatorCommand(argv: readonly string[]): OperatorCommand {
  const [group, action, flag, email, ...rest] = argv;
  if (
    group !== 'account' ||
    (action !== 'create' && action !== 'reset-password') ||
    flag !== '--email' ||
    !email ||
    email.length > 256 ||
    Array.from(email).some(isControl) ||
    rest.length > 0
  )
    throw new OperatorUsageError();
  return { action, email };
}

type Input = Readable & { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown };

/**
 * Reads one password line. On a terminal it is typed without echo; from a pipe it is the first
 * line. Nothing of it is ever written to `prompt`.
 */
export async function readPassword(input: Input, prompt: Writable): Promise<Secret> {
  const terminal = input.isTTY === true && typeof input.setRawMode === 'function';
  if (terminal) {
    prompt.write('Password (input hidden): ');
    input.setRawMode?.(true);
  }
  try {
    const line = await firstLine(input, terminal);
    if (line.length === 0)
      throw new OperatorUsageError('A password is required on standard input.');
    return new Secret(line);
  } finally {
    if (terminal) {
      input.setRawMode?.(false);
      prompt.write('\n');
    }
    input.pause();
  }
}

/** The bytes up to the first line end, or to the end of the stream. */
function firstLine(input: Input, terminal: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let bytes: Buffer = Buffer.alloc(0);
    const finish = (error?: Error) => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      if (error) reject(error);
      else resolve(bytes.toString('utf8').replace(/\r$/, ''));
    };
    const onEnd = () => {
      finish();
    };
    const onError = () => {
      finish(new OperatorUsageError('The password could not be read from standard input.'));
    };
    const onData = (chunk: Buffer | string) => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === 0x0a || (terminal && byte === 0x0d)) {
          finish();
          return;
        }
        // Without echo the terminal sends control keys as bytes: Ctrl-C and Ctrl-D end the
        // command, and a backspace removes the last byte typed.
        if (terminal && (byte === 0x03 || byte === 0x04)) {
          finish(new OperatorUsageError('Cancelled.'));
          return;
        }
        if (terminal && (byte === 0x7f || byte === 0x08)) {
          bytes = withoutLastCharacter(bytes);
          continue;
        }
        if (bytes.length >= MAX_PASSWORD_BYTES) {
          finish(new OperatorUsageError('The password line is too long.'));
          return;
        }
        bytes = Buffer.concat([bytes, Buffer.from([byte])]);
      }
    };
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
  });
}

/**
 * The bytes without their last character. In UTF-8 a character is one leading byte and up to
 * three continuation bytes (10xxxxxx): removing a single byte would leave a broken character,
 * and so a password other than the one typed.
 */
function withoutLastCharacter(bytes: Buffer): Buffer {
  let end = bytes.length;
  while (end > 0 && ((bytes[end - 1] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, Math.max(0, end - 1));
}

/** Writes a line and waits until it is handed over: the process exits right after. */
export function writeLine(output: Writable, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(`${line}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Runs one command and writes one line that says what was done. Never the password. */
export async function runOperatorCommand(
  app: INestApplicationContext,
  command: OperatorCommand,
  password: Secret,
  output: Writable,
): Promise<void> {
  const accounts = app.get(OperatorAccountCommands);
  if (command.action === 'create') {
    const created = await accounts.create(command.email, password);
    await writeLine(output, `Account created: ${created.email}`);
    return;
  }
  const email = await accounts.resetPassword(command.email, password);
  await writeLine(output, `Password reset: ${email}. Its sessions and API tokens no longer work.`);
}
