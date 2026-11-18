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
      else {
        // Strict: a decoder that replaces what it cannot read with U+FFFD would set a password
        // other than the one typed, which no browser would ever send (a Latin-1 terminal sends
        // é as one byte). A leading U+FEFF is a character of the line, not a marker to drop.
        let line: string;
        try {
          line = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          reject(
            new OperatorUsageError(
              'The password is not UTF-8 text: set the terminal or the file to UTF-8.',
            ),
          );
          return;
        }
        resolve(line.replace(/\r$/, ''));
      }
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
 * The bytes without their last code point. In UTF-8 a code point is one leading byte and up to
 * three continuation bytes (10xxxxxx): removing a single byte would leave a broken one, and so a
 * password other than the one typed. A letter typed as a base letter and a combining accent is
 * two code points: Backspace takes the accent, as the password rule counts them.
 */
function withoutLastCharacter(bytes: Buffer): Buffer {
  let end = bytes.length;
  while (end > 0 && ((bytes[end - 1] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, Math.max(0, end - 1));
}

/**
 * Writes a line and waits until it is handed over: the process exits right after. A write that
 * fails (a reader that closed its pipe) also emits `error` on the stream; unheard, that event ends
 * the process at once, before the caller decides what to do. It is heard here.
 */
export function writeLine(output: Writable, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error): void => {
      reject(error);
    };
    output.once('error', failed);
    output.write(`${line}\n`, (error) => {
      if (error) {
        // The event may come after this callback: the listener stays for it.
        reject(error);
        return;
      }
      output.off('error', failed);
      resolve();
    });
  });
}

/**
 * Says what was done. The change is committed by then: when the line cannot be written where it
 * belongs, it goes to the other stream and the command still succeeded. Reporting a failure here
 * would send the operator after a fault that did not happen, with a password already changed.
 */
async function confirm(output: Writable, fallback: Writable, line: string): Promise<void> {
  try {
    await writeLine(output, line);
  } catch {
    await writeLine(fallback, line).catch(() => undefined);
  }
}

/** Said on the error stream when the application does not close cleanly after a command. */
export const UNCLEAN_CLOSE =
  'Warning: the command is done, but the control plane did not close its connections cleanly.';

/** How long that warning may hold the result back when its stream does not drain (SPEC 8). */
const WARNING_PATIENCE_MS = 2000;

/**
 * Writes a line nobody waits for: it never fails, and a pipe whose reader stopped reading holds
 * the result back for a short time only. A terminal takes its writes at once, or holds every
 * program that writes to it until it is resumed: nothing here changes that.
 */
async function warn(output: Writable, line: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const patience = new Promise<void>((done) => {
    timer = setTimeout(done, WARNING_PATIENCE_MS);
  });
  await Promise.race([writeLine(output, line).catch(() => undefined), patience]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Runs one command, then closes the application. The result is the command's own: a close that
 * fails turns neither a committed change into a failure nor a refusal into another error. After
 * a success it is said as a warning, without its cause, which may hold connection details.
 * After a refusal nothing is added: the reason of the refusal is what the operator needs.
 */
export async function runThenClose(
  app: INestApplicationContext,
  command: OperatorCommand,
  password: Secret,
  output: Writable,
  fallback: Writable,
): Promise<void> {
  try {
    await runOperatorCommand(app, command, password, output, fallback);
  } catch (error: unknown) {
    await app.close().catch(() => undefined);
    throw error;
  }
  await app.close().catch(() => warn(fallback, UNCLEAN_CLOSE));
}

/**
 * Runs one command and writes one line that says what was done, on `output`, or on `fallback`
 * when `output` cannot take it. Never the password.
 */
export async function runOperatorCommand(
  app: INestApplicationContext,
  command: OperatorCommand,
  password: Secret,
  output: Writable,
  fallback: Writable,
): Promise<void> {
  const accounts = app.get(OperatorAccountCommands);
  if (command.action === 'create') {
    const created = await accounts.create(command.email, password);
    await confirm(output, fallback, `Account created: ${created.email}`);
    return;
  }
  const email = await accounts.resetPassword(command.email, password);
  await confirm(
    output,
    fallback,
    `Password reset: ${email}. Its sessions and API tokens no longer work.`,
  );
}
