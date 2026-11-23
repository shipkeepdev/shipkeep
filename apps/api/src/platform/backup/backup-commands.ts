// The `node main.js backup …` commands (ADR 0026). They run without the application: no database
// connection, nothing listening. deploy/control-plane/backup.sh runs them with `pg_dump` and
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

export type BackupCommand =
  | { readonly action: 'backup-keygen' }
  | { readonly action: 'backup-create' }
  | { readonly action: 'backup-restore-database' }
  | { readonly action: 'backup-restore-key' };

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
