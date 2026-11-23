// The commands of `node backup.js` (ADR 0026), a program apart from the control plane: it loads
// neither the application nor its settings, opens no database connection and listens on nothing. deploy/control-plane/backup.sh runs them with `pg_dump` and
// `pg_restore` from the PostgreSQL container, through pipes, so that no plaintext dump is written to
// disk.

import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  BackupRefusal,
  createArchive,
  drain,
  migrations,
  newIdentity,
  openArchive,
  readKek,
  replaceKek,
  splitIdentity,
} from './instance-backup';
import { ARCHIVE_NAME, check, discard, download, list, s3Settings, upload } from './s3-transfer';

export const BACKUP_USAGE = [
  'Usage, through deploy/control-plane/backup.sh, which pipes the database through these commands:',
  '  node backup.js keygen',
  '  node backup.js create',
  '  node backup.js restore-database',
  '  node backup.js restore-key --replace-this-installation',
  'and, in the container that reaches the S3 storage and never sees the key:',
  '  node backup.js upload NAME | download NAME | discard NAME | list | check',
].join('\n');

/** A command that cannot be read. Its message is the usage, never what was typed. */
export class BackupUsageError extends Error {
  constructor() {
    super(BACKUP_USAGE);
    this.name = 'BackupUsageError';
  }
}

/** Reads the arguments after `node backup.js`. The list is closed. */
export function parseBackupCommand(argv: readonly string[]): BackupCommand {
  const [action, ...rest] = argv;
  if (rest.length === 0) {
    if (action === 'keygen') return { action: 'backup-keygen' };
    if (action === 'create') return { action: 'backup-create' };
    if (action === 'restore-database') return { action: 'backup-restore-database' };
  }
  // Replacing the key-encryption key is destructive: it is said in full (CLAUDE.md rule 7).
  if (action === 'restore-key' && rest.length === 1 && rest[0] === '--replace-this-installation')
    return { action: 'backup-restore-key' };
  if (rest.length === 0 && action === 'list') return { action: 'backup-list' };
  if (rest.length === 0 && action === 'check') return { action: 'backup-check' };
  const [name] = rest;
  if (rest.length === 1 && name && ARCHIVE_NAME.test(name)) {
    if (action === 'upload') return { action: 'backup-upload', name };
    if (action === 'download') return { action: 'backup-download', name };
    if (action === 'discard') return { action: 'backup-discard', name };
  }
  throw new BackupUsageError();
}

export type BackupCommand =
  | { readonly action: 'backup-keygen' }
  | { readonly action: 'backup-create' }
  | { readonly action: 'backup-restore-database' }
  | { readonly action: 'backup-restore-key' }
  | {
      readonly action: 'backup-upload' | 'backup-download' | 'backup-discard';
      readonly name: string;
    }
  | { readonly action: 'backup-list' }
  | { readonly action: 'backup-check' };

export interface BackupIo {
  readonly stdin: Readable & { isTTY?: boolean };
  readonly stdout: Writable & { isTTY?: boolean };
  readonly stderr: Writable;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: Date;
}

/** Where the image keeps its migrations; a test points elsewhere. */
const MIGRATIONS = 'prisma/migrations';

export async function runBackup(command: BackupCommand, io: BackupIo): Promise<void> {
  switch (command.action) {
    case 'backup-keygen': {
      // The identity reads every backup: it goes to a file, never to a terminal.
      binaryOut(io, 'Write the identity to a file: backup keygen > backup-identity.txt');
      const { identity, recipient } = await newIdentity();
      await write(
        io.stdout,
        `# Shipkeep instance backups. Keep this file off the server.\n# public key: ${recipient}\n${identity}\n`,
      );
      await write(
        io.stderr,
        `Public key: ${recipient}\nSet SHIPKEEP_BACKUP_RECIPIENT=${recipient} in .env. Whoever holds the identity can read every backup and every secret in it: keep it off this server.\n`,
      );
      return;
    }
    case 'backup-create': {
      binaryIn(io, 'Standard input is the database dump: backup.sh create runs pg_dump into it.');
      binaryOut(io, 'Write the archive to a file: backup.sh create does.');
      const archive = await createArchive({
        recipient: io.env['SHIPKEEP_BACKUP_RECIPIENT'] ?? '',
        kek: await readKek(kekFile(io)),
        migration: (await migrations(io.env['SHIPKEEP_MIGRATIONS_DIR'] ?? MIGRATIONS)).at(-1) ?? '',
        now: io.now,
        dump: Readable.toWeb(io.stdin) as ReadableStream<Uint8Array>,
      });
      await pipeline(
        Readable.fromWeb(archive as Parameters<typeof Readable.fromWeb>[0]),
        io.stdout,
      );
      return;
    }
    case 'backup-restore-database': {
      binaryIn(
        io,
        'Standard input is the identity file, then the archive: backup.sh restore sends them.',
      );
      binaryOut(
        io,
        'Standard output is the database dump for pg_restore: backup.sh restore reads it.',
      );
      const opened = await open(io);
      await pipeline(
        Readable.fromWeb(opened.dump as Parameters<typeof Readable.fromWeb>[0]),
        io.stdout,
      );
      return;
    }
    case 'backup-upload': {
      binaryIn(io, 'Standard input is the archive: backup.sh create --s3 sends it.');
      await upload(s3Settings(io.env), command.name, io.stdin);
      await write(io.stderr, `Uploaded ${command.name}.\n`);
      return;
    }
    case 'backup-download': {
      binaryOut(io, 'Write the archive to a file: backup.sh restore s3:NAME does.');
      await download(s3Settings(io.env), command.name, io.stdout);
      return;
    }
    case 'backup-discard': {
      await discard(s3Settings(io.env), command.name);
      return;
    }
    case 'backup-list': {
      const archives = await list(s3Settings(io.env));
      await write(
        io.stdout,
        archives.map((a) => `${a.at}  ${String(a.bytes).padStart(12)}  ${a.name}\n`).join(''),
      );
      return;
    }
    case 'backup-check': {
      const settings = s3Settings(io.env);
      await check(settings);
      await write(
        io.stderr,
        `The S3 destination works: an object was written then deleted under ${settings.bucket}/${settings.prefix}.\n`,
      );
      return;
    }
    case 'backup-restore-key': {
      binaryIn(
        io,
        'Standard input is the identity file, then the archive: backup.sh restore sends them.',
      );
      const opened = await open(io);
      // The key changes only for an archive age has authenticated to its end.
      await drain(opened.dump);
      await replaceKek(kekFile(io), opened.kek, io.now);
      await write(
        io.stderr,
        `Key-encryption key restored from the backup of ${opened.manifest.createdAt}; the one it replaced is kept beside it.\n`,
      );
      return;
    }
  }
}

async function open(io: BackupIo) {
  const { identity, archive } = await splitIdentity(
    Readable.toWeb(io.stdin) as ReadableStream<Uint8Array>,
  );
  return openArchive({
    identity,
    archive,
    migrations: await migrations(io.env['SHIPKEEP_MIGRATIONS_DIR'] ?? MIGRATIONS),
  });
}

function kekFile(io: BackupIo): string {
  const path = io.env['SHIPKEEP_KEK_FILE'];
  if (!path) throw new BackupRefusal('SHIPKEEP_KEK_FILE is not set.');
  return path;
}

/** Binary data never goes to or comes from a terminal. */
function binaryIn(io: BackupIo, why: string): void {
  if (io.stdin.isTTY) throw new BackupRefusal(why);
}

function binaryOut(io: BackupIo, why: string): void {
  if (io.stdout.isTTY) throw new BackupRefusal(why);
}

function write(stream: Writable, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
