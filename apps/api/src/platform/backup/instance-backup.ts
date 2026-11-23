// Instance backup (ADR 0026, #231): the control plane's database and its key-encryption key in one
// archive, encrypted with age to a public key, so that creating a backup needs no secret and only
// whoever holds the matching identity, kept off this server, can read one.
//
// The archive is an age file. Its plaintext is a manifest line (JSON), then a `pg_dump --format=
// custom` stream. age authenticates every chunk and the end of the stream, so a changed or cut
// archive is refused, not restored in part.
//
// age does not say who wrote an archive: anyone with the public key can encrypt to it. So the
// manifest also carries a tag, an HMAC under a key derived from the identity, which `keygen` leaves
// on the server. An archive is restored only when its tag matches the identity it is opened with,
// before a byte of it reaches pg_restore. age binds every chunk to the same file key, so whoever
// wrote the manifest wrote the rest.

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
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
const AUTHENTICATION_BYTES = 32;
const AUTHENTICATION_INFO = 'shipkeep-instance-backup/1 authentication';

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
    /** HMAC-SHA256 of the fields above under the backup key: who wrote the archive. */
    authentication: z.base64(),
  })
  .strict();

/** What the archive says about itself; the key-encryption key is in it. */
export type BackupManifest = z.infer<typeof manifestSchema>;

/**
 * What the server keeps to make backups (`backup keygen`, in the keys volume): the public key they
 * are encrypted to, and the key their manifest is authenticated with. Both come from the identity;
 * neither gives it back.
 */
export interface BackupKey {
  readonly recipient: string;
  readonly authentication: Uint8Array;
}

const backupKeySchema = z
  .object({ recipient: z.string().regex(RECIPIENT), authentication: z.base64() })
  .strict();

/** A new identity, for `backup keygen`, and the public key that backups are encrypted to. */
export async function newIdentity(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

/** The backup key of an identity: what `keygen` leaves on the server, and a restore checks. */
export async function backupKeyFor(identity: string): Promise<BackupKey> {
  if (!IDENTITY.test(identity))
    throw new BackupRefusal('The identity is not an age secret key (AGE-SECRET-KEY-1…).');
  return {
    recipient: await identityToRecipient(identity),
    authentication: new Uint8Array(
      hkdfSync('sha256', identity, new Uint8Array(0), AUTHENTICATION_INFO, AUTHENTICATION_BYTES),
    ),
  };
}

/** The server's backup key, which `backup keygen` writes. */
export async function readBackupKey(path: string): Promise<BackupKey> {
  const text = await readFile(path, 'utf8').catch(() => {
    throw new BackupRefusal('This server has no backup key: create one with ./backup.sh keygen.');
  });
  let parsed: z.infer<typeof backupKeySchema>;
  try {
    parsed = backupKeySchema.parse(JSON.parse(text));
  } catch {
    throw new BackupRefusal(
      'The backup key of this server cannot be read: run ./backup.sh keygen.',
    );
  }
  const authentication = new Uint8Array(Buffer.from(parsed.authentication, 'base64'));
  if (authentication.length !== AUTHENTICATION_BYTES)
    throw new BackupRefusal(
      'The backup key of this server cannot be read: run ./backup.sh keygen.',
    );
  return { recipient: parsed.recipient, authentication };
}

/** Writes the server's backup key, read-only for its owner, in place of the one before. */
export async function writeBackupKey(path: string, key: BackupKey): Promise<void> {
  const text = `${JSON.stringify({
    recipient: key.recipient,
    authentication: Buffer.from(key.authentication).toString('base64'),
  })}\n`;
  await writeInPlace(path, new TextEncoder().encode(text));
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
  readonly key: BackupKey;
  readonly kek: Uint8Array;
  readonly migration: string;
  readonly now: Date;
  readonly dump: ReadableStream<Uint8Array>;
}): Promise<ReadableStream<Uint8Array>> {
  if (
    !RECIPIENT.test(input.key.recipient) ||
    input.key.authentication.length !== AUTHENTICATION_BYTES
  )
    throw new BackupRefusal(
      'The backup key of this server cannot be read: run ./backup.sh keygen.',
    );
  if (input.kek.length !== KEK_BYTES || !MIGRATION.test(input.migration))
    throw new BackupRefusal('The backup cannot be described: key or migration missing.');
  const fields = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: input.now.toISOString(),
    migration: input.migration,
    kek: Buffer.from(input.kek).toString('base64'),
  } as const;
  const manifest: BackupManifest = {
    ...fields,
    authentication: tag(input.key.authentication, fields),
  };
  const head = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
  const encrypter = new Encrypter();
  encrypter.addRecipient(input.key.recipient);
  return encrypter.encrypt(ReadableStream.from(concat(head, checkedDump(input.dump))));
}

/**
 * Opens an archive with `identity`. The manifest is checked before anything else is read: its
 * format, its tag, which only the server that holds this identity's backup key can write, and a
 * migration this image carries, since a backup is restored by the same version of Shipkeep or a
 * later one. `dump` is the rest, authenticated chunk by chunk as it is read: a changed or cut
 * archive makes it fail.
 */
export async function openArchive(input: {
  readonly identity: string;
  readonly archive: ReadableStream<Uint8Array>;
  readonly migrations: readonly string[];
}): Promise<{ manifest: BackupManifest; kek: Uint8Array; dump: ReadableStream<Uint8Array> }> {
  const key = await backupKeyFor(input.identity);
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
  const expected = Buffer.from(tag(key.authentication, manifest), 'base64');
  const found = Buffer.from(manifest.authentication, 'base64');
  if (expected.length !== found.length || !timingSafeEqual(expected, found))
    throw new BackupRefusal(
      'This archive was not made by a server that backs up to this identity: it is not restored.',
    );
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
  await syncDirectory(path);
}

/** The manifest's tag: an HMAC of its fields, one per line, in a fixed order. */
function tag(
  key: Uint8Array,
  fields: Pick<BackupManifest, 'format' | 'version' | 'createdAt' | 'migration' | 'kek'>,
): string {
  return createHmac('sha256', key)
    .update(
      [fields.format, String(fields.version), fields.createdAt, fields.migration, fields.kek].join(
        '\n',
      ),
    )
    .digest('base64');
}

/** Writes `bytes` read-only for its owner under `path`, replacing it only once they are on disk. */
async function writeInPlace(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.writing`;
  await rm(temporary, { force: true });
  const file = await open(temporary, 'wx', 0o400);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await syncDirectory(path);
}

async function syncDirectory(path: string): Promise<void> {
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
