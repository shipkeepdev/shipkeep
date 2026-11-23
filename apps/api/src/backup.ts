// Instance backup of the control plane (ADR 0026), a program apart from main.js: it loads neither
// the application nor its settings, so it runs with nothing but the key file and the pipes that
// deploy/control-plane/backup.sh connects to pg_dump and pg_restore.
//
//   node backup.js keygen | create | restore-database | restore-key --replace-this-installation

import { BackupUsageError, parseBackupCommand, runBackup } from './platform/backup/backup-commands';
import { BackupRefusal } from './platform/backup/instance-backup';

async function backup(): Promise<void> {
  await runBackup(parseBackupCommand(process.argv.slice(2)), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    now: new Date(),
  });
}

backup().then(
  () => process.exit(0),
  (error: unknown) => {
    // A refusal says why in words meant for people; anything else stays short.
    const message =
      error instanceof BackupRefusal || error instanceof BackupUsageError
        ? error.message
        : 'The backup command failed.';
    process.stderr.write(`${message}\n`, () =>
      process.exit(error instanceof BackupUsageError ? 2 : 1),
    );
  },
);
