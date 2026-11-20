// The command line of the control plane, for whoever operates the server (ADR 0020):
//
//   node main.js account create --email <address>
//   node main.js account reset-password --email <address>
//   node main.js organization create --name <name> --slug <slug> --owner <address> [--id <uuid>]
//   node main.js server join-token --organization <id>
//   node main.js server ca-fingerprint
//
// The password never comes as an argument or a variable, where other processes could read it: it
// is typed without echo on a terminal, or is the first line of a pipe. The last three are for the
// single-machine installer (ADR 0021); a join token is a secret and is never written to a terminal.

import type { Readable, Writable } from 'node:stream';

import type { INestApplicationContext } from '@nestjs/common';
import { isDomainError, Secret, SYSTEM_ACTOR } from '@shipkeep/domain';

import { IssueJoinToken } from './modules/fleet/application/issue-join-token';
import {
  CERTIFICATE_AUTHORITY,
  type CertificateAuthority,
} from './modules/fleet/application/ports';
import { OperatorAccountCommands } from './modules/identity/application/operator-account-commands';
import { OperatorOrganizationCommands } from './modules/organizations/application/operator-organization-commands';

export const USAGE = [
  'Usage, on the server that runs the control plane:',
  '  node main.js account create --email <address>',
  '  node main.js account reset-password --email <address>',
  '  node main.js organization create --name <name> --slug <slug> --owner <address> [--id <uuid>]',
  '  node main.js server join-token --organization <id>',
  '  node main.js server ca-fingerprint',
  'The password is read from standard input: typed without echo on a terminal, or the first line of a pipe.',
  "A join token is written to standard output only when it is not a terminal, such as the agent's token file.",
].join('\n');

/** A command that cannot be read. Its message is the usage, never what was typed. */
export class OperatorUsageError extends Error {
  constructor(message = USAGE) {
    super(message);
    this.name = 'OperatorUsageError';
  }
}

export type OperatorCommand =
  | { readonly action: 'create' | 'reset-password'; readonly email: string }
  | {
      readonly action: 'organization-create';
      readonly name: string;
      readonly slug: string;
      readonly owner: string;
      readonly id?: string;
    }
  | { readonly action: 'join-token'; readonly organizationId: string }
  | { readonly action: 'ca-fingerprint' };

/**
 * The exit status of a failed command: 2 for a command that cannot be read, 3 when the account to
 * create already exists (an installer resuming its own run treats it as done), 1 otherwise.
 */
export function operatorExitCode(error: unknown): number {
  if (error instanceof OperatorUsageError) return 2;
  if (isDomainError(error) && error.code === 'account_exists') return 3;
  return 1;
}

/** Only the account commands read a password. */
export function needsPassword(command: OperatorCommand): boolean {
  return command.action === 'create' || command.action === 'reset-password';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Longest password line accepted: the policy allows 128 characters, of four bytes at most. */
const MAX_PASSWORD_BYTES = 1024;
/** A control character: an address never holds one, and a terminal would act on it. */
const isControl = (character: string): boolean =>
  character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127;

/** A value given on the command line: present, bounded, and free of control characters. */
const plain = (value: string | undefined, max: number): value is string =>
  !!value && value.length <= max && !Array.from(value).some(isControl);

/** Reads the arguments after `node main.js`. The list of commands is closed. */
export function parseOperatorCommand(argv: readonly string[]): OperatorCommand {
  const [group, action] = argv;
  if (group === 'account') {
    const [, , flag, email, ...rest] = argv;
    if (
      (action === 'create' || action === 'reset-password') &&
      flag === '--email' &&
      plain(email, 256) &&
      rest.length === 0
    )
      return { action, email };
  }
  if (group === 'organization' && action === 'create') {
    const [, , nameFlag, name, slugFlag, slug, ownerFlag, owner, ...extra] = argv;
    if (
      nameFlag === '--name' &&
      plain(name, 128) &&
      slugFlag === '--slug' &&
      plain(slug, 64) &&
      ownerFlag === '--owner' &&
      plain(owner, 256)
    ) {
      if (extra.length === 0) return { action: 'organization-create', name, slug, owner };
      // An id chosen by the installer, so that a resumed run finds the organization again.
      const [idFlag, id] = extra;
      if (extra.length === 2 && idFlag === '--id' && UUID.test(id))
        return { action: 'organization-create', name, slug, owner, id };
    }
  }
  if (group === 'server' && action === 'join-token') {
    const [, , flag, organizationId, ...rest] = argv;
    if (
      flag === '--organization' &&
      // A missing value reads as the text "undefined", which is no id.
      UUID.test(organizationId) &&
      rest.length === 0
    )
      return { action: 'join-token', organizationId };
  }
  if (group === 'server' && action === 'ca-fingerprint' && argv.length === 2)
    return { action: 'ca-fingerprint' };
  throw new OperatorUsageError();
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
  password: Secret | undefined,
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
  password: Secret | undefined,
  output: Writable,
  fallback: Writable,
): Promise<void> {
  if (command.action === 'organization-create') {
    const owner = await app.get(OperatorAccountCommands).activeAccountId(command.owner);
    const organization = await app
      .get(OperatorOrganizationCommands)
      .create({ name: command.name, slug: command.slug }, owner, new Date(), command.id);
    await confirm(output, fallback, `Organization created: ${organization.id}`);
    return;
  }
  if (command.action === 'join-token') {
    // Refused before a token exists: a secret on a terminal stays on the screen and in scrollback.
    if ((output as Writable & { isTTY?: boolean }).isTTY === true)
      throw new OperatorUsageError(
        "The join token is a secret: send it to a file, such as the agent's token file, not to a terminal.",
      );
    const issued = await app
      .get(IssueJoinToken)
      .execute({ organizationId: command.organizationId, actor: SYSTEM_ACTOR });
    // Never to the other stream, which may be a terminal: an unwritten token expires unused.
    await writeLine(output, issued.value.expose());
    return;
  }
  if (command.action === 'ca-fingerprint') {
    const ca = app.get<CertificateAuthority>(CERTIFICATE_AUTHORITY);
    await confirm(output, fallback, await ca.caFingerprint());
    return;
  }
  if (!password) throw new OperatorUsageError('A password is required on standard input.');
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
