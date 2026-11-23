// Instance backup (ADR 0026, #231): the control plane's database and its key-encryption key in one
// archive, encrypted with age to a public key, so that creating a backup needs no secret and only
// whoever holds the matching identity, kept off this server, can read one.
//
// The archive is an age file. Its plaintext is a manifest line (JSON), then a `pg_dump --format=
// custom` stream. age authenticates every chunk and the end of the stream, so a changed or cut
// archive is refused, not restored in part.

import { open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { z } from 'zod';

export const BACKUP_FORMAT = 'shipkeep-instance-backup';
const BACKUP_VERSION = 1;
const KEK_BYTES = 32;
/** What `pg_dump --format=custom` starts with. */
const DUMP_MAGIC = new TextEncoder().encode('PGDMP');
const MAX_MANIFEST_BYTES = 64 * 1024;
/** The identity part of what `restore` reads before the archive: a key file, with comments. */
const MAX_IDENTITY_BYTES = 8 * 1024;
const AGE_HEADER = new TextEncoder().encode('age-encryption.org/v1\n');
/** A Prisma migration directory: a UTC timestamp, then a name. */
const MIGRATION = /^\d{14}_[a-z0-9_]{1,100}$/;
/** An age X25519 recipient and identity (Bech32): what every age tool reads. */
export const RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/;
const IDENTITY = /^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/;

/** A refusal, in words meant for the person who runs the command. It never holds a secret. */
export class BackupRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupRefusal';
  }
}

const manifestSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    version: z.literal(BACKUP_VERSION),
    createdAt: z.iso.datetime(),
    migration: z.string().regex(MIGRATION),
    kek: z.base64(),
  })
  .strict();

/** What the archive says about itself; the key-encryption key is in it. */
export type BackupManifest = z.infer<typeof manifestSchema>;

/** A new identity, for `backup keygen`, and the public key that backups are encrypted to. */
export async function newIdentity(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

/** The migrations this image carries, newest last. */
export async function migrations(directory: string): Promise<string[]> {
  const names = (await readdir(directory)).filter((name) => MIGRATION.test(name)).sort();
  if (!names.length) throw new BackupRefusal('This image carries no database migration.');
  return names;
}

/** The key-encryption key: exactly 32 bytes, as `ensure-kek.mjs` writes it. */
export async function readKek(path: string): Promise<Uint8Array> {
  const bytes = await readFile(path).catch(() => {
    throw new BackupRefusal('The key-encryption key cannot be read: SHIPKEEP_KEK_FILE.');
  });
  if (bytes.length !== KEK_BYTES)
    throw new BackupRefusal('The key-encryption key is not the 32 bytes the control plane writes.');
  return new Uint8Array(bytes);
}

/**
 * The archive of a database dump and the key-encryption key, encrypted to `recipient`. `dump` is
 * `pg_dump --format=custom`; anything else is refused before a byte is written.
 */
export async function createArchive(input: {
  readonly recipient: string;
  readonly kek: Uint8Array;
  readonly migration: string;
  readonly now: Date;
  readonly dump: ReadableStream<Uint8Array>;
}): Promise<ReadableStream<Uint8Array>> {
  if (!RECIPIENT.test(input.recipient))
    throw new BackupRefusal(
      'SHIPKEEP_BACKUP_RECIPIENT is not an age public key (age1…): create one with `backup keygen`.',
    );
  if (input.kek.length !== KEK_BYTES || !MIGRATION.test(input.migration))
    throw new BackupRefusal('The backup cannot be described: key or migration missing.');
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: input.now.toISOString(),
    migration: input.migration,
    kek: Buffer.from(input.kek).toString('base64'),
  };
  const head = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
  const encrypter = new Encrypter();
  encrypter.addRecipient(input.recipient);
  return encrypter.encrypt(ReadableStream.from(concat(head, checkedDump(input.dump))));
}

/**
 * Opens an archive with `identity`. The manifest is checked before anything else is read: its
 * format, and a migration this image carries, since a backup is restored by the same version of
 * Shipkeep or a later one. `dump` is the rest, authenticated chunk by chunk as it is read: a
 * changed or cut archive makes it fail.
 */
export async function openArchive(input: {
  readonly identity: string;
  readonly archive: ReadableStream<Uint8Array>;
  readonly migrations: readonly string[];
}): Promise<{ manifest: BackupManifest; kek: Uint8Array; dump: ReadableStream<Uint8Array> }> {
  if (!IDENTITY.test(input.identity))
    throw new BackupRefusal('The identity is not an age secret key (AGE-SECRET-KEY-1…).');
  const decrypter = new Decrypter();
  decrypter.addIdentity(input.identity);
  let plaintext: ReadableStream<Uint8Array>;
  try {
    plaintext = await decrypter.decrypt(input.archive);
  } catch {
    throw new BackupRefusal(
      'This archive cannot be opened with this identity, or is not a Shipkeep backup.',
    );
  }
  const reader = plaintext.getReader();
  const { line, rest } = await readLine(reader, MAX_MANIFEST_BYTES);
  let manifest: BackupManifest;
  try {
    manifest = manifestSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)),
    );
  } catch {
    throw new BackupRefusal('This archive is not a Shipkeep instance backup of a known version.');
  }
  if (!input.migrations.includes(manifest.migration))
    throw new BackupRefusal(
      `This backup comes from a newer version of Shipkeep (database migration ${manifest.migration}): restore it with that version or a later one.`,
    );
  const kek = new Uint8Array(Buffer.from(manifest.kek, 'base64'));
  if (kek.length !== KEK_BYTES)
    throw new BackupRefusal('The key-encryption key in this backup is not 32 bytes.');
  return {
    manifest,
    kek,
    dump: ReadableStream.from(checkedDump(ReadableStream.from(concat(rest, remaining(reader))))),
  };
}

/**
 * Splits what `restore` reads: an identity file (comments and blank lines allowed, one secret
 * key), then the archive, which starts with the age header line.
 */
export async function splitIdentity(
  input: ReadableStream<Uint8Array>,
): Promise<{ identity: string; archive: ReadableStream<Uint8Array> }> {
  const reader = input.getReader();
  let buffered: Uint8Array = new Uint8Array(0);
  for (;;) {
    const at = indexOf(buffered, AGE_HEADER);
    if (at >= 0) {
      const identity = identityLine(buffered.subarray(0, at));
      return {
        identity,
        archive: ReadableStream.from(concat(buffered.subarray(at), remaining(reader))),
      };
    }
    if (buffered.length > MAX_IDENTITY_BYTES + AGE_HEADER.length)
      throw new BackupRefusal(
        'Standard input does not start with an age identity file followed by the archive.',
      );
    const { done, value } = await reader.read();
    if (done)
      throw new BackupRefusal(
        'Standard input does not start with an age identity file followed by the archive.',
      );
    buffered = join(buffered, value);
  }
}

/** Reads the whole stream, so that age authenticates every chunk up to its end. */
export async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

/**
 * Replaces the key-encryption key with `kek`, read-only for its owner, as `ensure-kek.mjs` writes
 * it. The key it replaces is kept next to it, named for the moment, and the new one is renamed into
 * place only once it is on disk.
 */
export async function replaceKek(path: string, kek: Uint8Array, now: Date): Promise<void> {
  if (kek.length !== KEK_BYTES) throw new BackupRefusal('A key-encryption key is 32 bytes.');
  const temporary = `${path}.restoring`;
  await rm(temporary, { force: true });
  const file = await open(temporary, 'wx', 0o400);
  try {
    await file.writeFile(kek);
    await file.sync();
  } finally {
    await file.close();
  }
  const kept = `${path}.before-restore-${now
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14)}`;
  try {
    await rename(path, kept);
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function identityLine(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BackupRefusal('The identity file is not text.');
  }
  const keys = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const key = keys.length === 1 ? keys[0] : undefined;
  if (key === undefined || !IDENTITY.test(key))
    throw new BackupRefusal('The identity file must hold one age secret key (AGE-SECRET-KEY-1…).');
  return key;
}

/** Fails the stream unless it starts as a custom-format pg_dump archive. */
async function* checkedDump(dump: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = dump.getReader();
  let head: Uint8Array = new Uint8Array(0);
  while (head.length < DUMP_MAGIC.length) {
    const { done, value } = await read(reader);
    if (done) throw new BackupRefusal('The database dump is empty or cut short.');
    head = join(head, value);
  }
  if (!DUMP_MAGIC.every((byte, index) => head[index] === byte))
    throw new BackupRefusal('The database dump is not a pg_dump archive in custom format.');
  yield head;
  yield* remaining(reader);
}

async function* concat(
  first: Uint8Array,
  rest: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (first.length) yield first;
  yield* rest;
}

async function* remaining(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  for (;;) {
    const { done, value } = await read(reader);
    if (done) return;
    yield value;
  }
}

/** A read whose failure (age refusing a chunk) says what it means. */
async function read(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  try {
    return await reader.read();
  } catch (error: unknown) {
    if (error instanceof BackupRefusal) throw error;
    throw new BackupRefusal('The archive is damaged or was changed: nothing more is read from it.');
  }
}

async function readLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  max: number,
): Promise<{ line: Uint8Array; rest: Uint8Array }> {
  let buffered: Uint8Array = new Uint8Array(0);
  for (;;) {
    const end = buffered.indexOf(0x0a);
    if (end >= 0) return { line: buffered.subarray(0, end), rest: buffered.subarray(end + 1) };
    if (buffered.length > max)
      throw new BackupRefusal('This archive is not a Shipkeep instance backup of a known version.');
    const { done, value } = await read(reader);
    if (done)
      throw new BackupRefusal('This archive is not a Shipkeep instance backup of a known version.');
    buffered = join(buffered, value);
  }
}

function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
