import { mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { BackupUsageError, parseBackupCommand, runBackup } from './backup-commands';
import {
  BackupRefusal,
  createArchive,
  newIdentity,
  openArchive,
  replaceKek,
  splitIdentity,
} from './instance-backup';

const MIGRATION = '20261123090000_deployment_maintenance';
const NOW = new Date('2026-11-23T10:00:00Z');
const kek = new Uint8Array(32).map((_, index) => index + 1);

/** A custom-format pg_dump starts with PGDMP; 200 KiB spans several age chunks of 64 KiB. */
function dump(size = 200 * 1024): Uint8Array {
  const bytes = new Uint8Array(size).map((_, index) => (index * 7) % 251);
  bytes.set(new TextEncoder().encode('PGDMP'));
  return bytes;
}

function stream(bytes: Uint8Array, chunk = 10_000): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
  });
}

async function collect(input: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of input) parts.push(part);
  return new Uint8Array(Buffer.concat(parts));
}

async function archive(recipient: string, data = dump()): Promise<Uint8Array> {
  return collect(
    await createArchive({ recipient, kek, migration: MIGRATION, now: NOW, dump: stream(data) }),
  );
}

describe('instance backup archive (ADR 0026)', () => {
  it('carries the dump and the key-encryption key, readable with the identity only', async () => {
    const { identity, recipient } = await newIdentity();
    const data = dump();
    const sealed = await archive(recipient, data);
    // An age file: nothing of the key or the dump in clear.
    expect(new TextDecoder().decode(sealed.subarray(0, 21))).toBe('age-encryption.org/v1');
    expect(Buffer.from(sealed).includes(Buffer.from(kek))).toBe(false);
    expect(Buffer.from(sealed).includes(Buffer.from('PGDMP'))).toBe(false);

    const opened = await openArchive({
      identity,
      archive: stream(sealed),
      migrations: [MIGRATION],
    });
    expect(opened.manifest).toMatchObject({
      format: 'shipkeep-instance-backup',
      version: 1,
      createdAt: NOW.toISOString(),
      migration: MIGRATION,
    });
    expect(opened.kek).toEqual(kek);
    expect(await collect(opened.dump)).toEqual(data);

    const other = await newIdentity();
    await expect(
      openArchive({ identity: other.identity, archive: stream(sealed), migrations: [MIGRATION] }),
    ).rejects.toThrow(BackupRefusal);
  });

  it('refuses a changed or cut archive instead of restoring part of it', async () => {
    const { identity, recipient } = await newIdentity();
    const sealed = await archive(recipient);
    const changed = sealed.slice();
    changed[changed.length - 1000] = (changed[changed.length - 1000] ?? 0) ^ 1;
    const cut = sealed.slice(0, sealed.length - 70 * 1024);
    for (const broken of [changed, cut]) {
      const opened = await openArchive({
        identity,
        archive: stream(broken),
        migrations: [MIGRATION],
      });
      await expect(collect(opened.dump)).rejects.toThrow('The archive is damaged or was changed');
    }
  });

  it('is restored by the same version of Shipkeep or a later one only', async () => {
    const { identity, recipient } = await newIdentity();
    const sealed = await archive(recipient);
    await expect(
      openArchive({
        identity,
        archive: stream(sealed),
        migrations: ['20261121130000_user_display_name'],
      }),
    ).rejects.toThrow('newer version of Shipkeep');
  });

  it('takes a public key, and a custom-format dump only', async () => {
    const { recipient } = await newIdentity();
    await expect(
      createArchive({
        recipient: 'AGE-SECRET-KEY-1x',
        kek,
        migration: MIGRATION,
        now: NOW,
        dump: stream(dump()),
      }),
    ).rejects.toThrow('SHIPKEEP_BACKUP_RECIPIENT');
    const plain = new TextEncoder().encode('-- PostgreSQL database dump\nCREATE TABLE x();\n');
    await expect(archive(recipient, plain)).rejects.toThrow(
      'not a pg_dump archive in custom format',
    );
    await expect(archive(recipient, new Uint8Array(0))).rejects.toThrow('empty or cut short');
  });

  it('reads an identity file, comments included, followed by the archive', async () => {
    const { identity, recipient } = await newIdentity();
    const sealed = await archive(recipient);
    const file = new TextEncoder().encode(
      `# created by backup keygen\n# public key: ${recipient}\n${identity}\n`,
    );
    const split = await splitIdentity(stream(new Uint8Array(Buffer.concat([file, sealed]))));
    expect(split.identity).toBe(identity);
    expect(await collect(split.archive)).toEqual(sealed);
    for (const bad of [
      new TextEncoder().encode('not an identity\n'),
      new TextEncoder().encode(`${identity}\n${identity}\n`),
    ])
      await expect(
        splitIdentity(stream(new Uint8Array(Buffer.concat([bad, sealed])))),
      ).rejects.toThrow(BackupRefusal);
  });

  it('replaces the key-encryption key read-only, keeping the one it replaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kek-'));
    const path = join(directory, 'kek');
    await writeFile(path, Buffer.alloc(32, 9), { mode: 0o400 });
    await replaceKek(path, kek, NOW);
    expect(new Uint8Array(await readFile(path))).toEqual(kek);
    expect((await stat(path)).mode & 0o777).toBe(0o400);
    const kept = (await readdir(directory)).filter((name) =>
      name.startsWith('kek.before-restore-'),
    );
    expect(kept).toEqual(['kek.before-restore-20261123100000']);
    expect(await readFile(join(directory, kept[0] ?? ''))).toEqual(Buffer.alloc(32, 9));
  });
});

describe('backup commands', () => {
  it('reads a closed list, and restores a key only when told so in full', () => {
    expect(parseBackupCommand(['keygen'])).toEqual({ action: 'backup-keygen' });
    expect(parseBackupCommand(['create'])).toEqual({ action: 'backup-create' });
    expect(parseBackupCommand(['restore-database'])).toEqual({ action: 'backup-restore-database' });
    expect(parseBackupCommand(['restore-key', '--replace-this-installation'])).toEqual({
      action: 'backup-restore-key',
    });
    for (const argv of [
      [],
      ['restore-key'],
      ['restore-key', '--yes'],
      ['create', '--to', '/tmp/x'],
      ['restore'],
      ['keygen', 'extra'],
      ['account', 'create', '--email', 'a@example.com'],
    ])
      expect(() => parseBackupCommand(argv), JSON.stringify(argv)).toThrow(BackupUsageError);
  });

  async function run(
    action: Parameters<typeof runBackup>[0]['action'],
    input: Uint8Array,
    env: Record<string, string>,
  ) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => out.push(chunk));
    stderr.on('data', (chunk: Buffer) => err.push(chunk));
    stdin.end(Buffer.from(input));
    await runBackup(
      { action },
      {
        stdin,
        stdout,
        stderr,
        env,
        now: NOW,
      },
    );
    return { out: new Uint8Array(Buffer.concat(out)), err: Buffer.concat(err).toString() };
  }

  it('creates a backup, then restores the database and the key from it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-'));
    const migrations = join(directory, 'migrations');
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(join(migrations, MIGRATION), { recursive: true }),
    );
    const kekFile = join(directory, 'kek');
    await writeFile(kekFile, Buffer.from(kek), { mode: 0o400 });

    const generated = await run('backup-keygen', new Uint8Array(0), {});
    const identityFile = generated.out;
    const recipient = /Public key: (age1\S+)/.exec(generated.err)?.[1] ?? '';
    expect(generated.err).toContain('keep it off this server');
    const env = {
      SHIPKEEP_KEK_FILE: kekFile,
      SHIPKEEP_MIGRATIONS_DIR: migrations,
      SHIPKEEP_BACKUP_RECIPIENT: recipient,
    };

    const data = dump();
    const created = await run('backup-create', data, env);
    const input = new Uint8Array(Buffer.concat([identityFile, created.out]));
    const restored = await run('backup-restore-database', input, env);
    expect(restored.out).toEqual(data);

    // A fresh installation has its own key: restoring puts the backup's in its place.
    await import('node:fs/promises').then(async (fs) => {
      await fs.rm(kekFile, { force: true });
      await fs.writeFile(kekFile, Buffer.alloc(32, 7), { mode: 0o400 });
    });
    const key = await run('backup-restore-key', input, env);
    expect(new Uint8Array(await readFile(kekFile))).toEqual(kek);
    expect(key.err).toContain(
      'Key-encryption key restored from the backup of 2026-11-23T10:00:00.000Z',
    );
  });

  it('never writes an identity or an archive to a terminal, nor reads a dump from one', async () => {
    const terminal = Object.assign(new PassThrough(), { isTTY: true });
    const pipe = new PassThrough();
    await expect(
      runBackup(
        { action: 'backup-keygen' },
        { stdin: pipe, stdout: terminal, stderr: pipe, env: {}, now: NOW },
      ),
    ).rejects.toThrow('Write the identity to a file');
    await expect(
      runBackup(
        { action: 'backup-create' },
        { stdin: terminal, stdout: pipe, stderr: pipe, env: {}, now: NOW },
      ),
    ).rejects.toThrow('Standard input is the database dump');
  });
});
