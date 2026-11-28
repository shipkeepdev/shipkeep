import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { Encrypter } from 'age-encryption';

import { BackupUsageError, parseBackupCommand, runBackup } from './backup-commands';
import {
  BackupRefusal,
  type BackupKey,
  backupKeyFor,
  createArchive,
  newIdentity,
  openArchive,
  readBackupKey,
  replaceKek,
  splitIdentity,
  writeBackupKey as writeBackupKeyFile,
} from './instance-backup';

const MIGRATION = '20261123090000_deployment_maintenance';
const NOW = new Date('2026-11-23T10:00:00Z');
/** The name `backup.sh create --s3` would give it. */
const NAME = 'shipkeep-20261123-100000-3f9a1c2e.age';
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

async function archive(key: BackupKey, data = dump(), name = NAME): Promise<Uint8Array> {
  return collect(
    await createArchive({ key, kek, migration: MIGRATION, now: NOW, name, dump: stream(data) }),
  );
}

/** An archive with this manifest, made by hand: what a server of another version would write. */
async function sealed(recipient: string, manifest: Record<string, unknown>): Promise<Uint8Array> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const head = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
  return collect(await encrypter.encrypt(stream(new Uint8Array(Buffer.concat([head, dump()])))));
}

/** An identity, and the backup key `keygen` leaves on the server for it. */
async function pair(): Promise<{ identity: string; key: BackupKey }> {
  const { identity } = await newIdentity();
  return { identity, key: await backupKeyFor(identity) };
}

describe('instance backup archive (ADR 0026)', () => {
  it('carries the dump and the key-encryption key, readable with the identity only', async () => {
    const { identity, key } = await pair();
    const data = dump();
    const sealed = await archive(key, data);
    // An age file: nothing of the key or the dump in clear.
    expect(new TextDecoder().decode(sealed.subarray(0, 21))).toBe('age-encryption.org/v1');
    expect(Buffer.from(sealed).includes(Buffer.from(kek))).toBe(false);
    expect(Buffer.from(sealed).includes(Buffer.from('PGDMP'))).toBe(false);

    const opened = await openArchive({
      identity,
      archive: stream(sealed),
      name: NAME,
      migrations: [MIGRATION],
    });
    expect(opened.manifest).toMatchObject({
      format: 'shipkeep-instance-backup',
      version: 2,
      createdAt: NOW.toISOString(),
      migration: MIGRATION,
      name: NAME,
    });
    expect(opened.kek).toEqual(kek);
    expect(await collect(opened.dump)).toEqual(data);

    const other = await newIdentity();
    await expect(
      openArchive({
        identity: other.identity,
        archive: stream(sealed),
        name: NAME,
        migrations: [MIGRATION],
      }),
    ).rejects.toThrow(BackupRefusal);
  });

  it('refuses an archive written by anyone but the server that holds the backup key', async () => {
    const { identity, key } = await pair();
    // Whoever knows the public key can encrypt to it: the forger has the recipient, not the key.
    const forger = await pair();
    const forged = await archive({
      recipient: key.recipient,
      authentication: forger.key.authentication,
    });
    // Refused when the manifest is read, before the dump is handed to anything.
    await expect(
      openArchive({ identity, archive: stream(forged), name: NAME, migrations: [MIGRATION] }),
    ).rejects.toThrow('was not made by a server that backs up to this identity');
    // The genuine archive opens: the tag is what differs.
    await expect(
      openArchive({
        identity,
        archive: stream(await archive(key)),
        name: NAME,
        migrations: [MIGRATION],
      }),
    ).resolves.toMatchObject({ manifest: { migration: MIGRATION } });
  });

  it('refuses a changed or cut archive instead of restoring part of it', async () => {
    const { identity, key } = await pair();
    const sealed = await archive(key);
    const changed = sealed.slice();
    changed[changed.length - 1000] = (changed[changed.length - 1000] ?? 0) ^ 1;
    const cut = sealed.slice(0, sealed.length - 70 * 1024);
    for (const broken of [changed, cut]) {
      const opened = await openArchive({
        identity,
        archive: stream(broken),
        name: NAME,
        migrations: [MIGRATION],
      });
      await expect(collect(opened.dump)).rejects.toThrow('The archive is damaged or was changed');
    }
  });

  it('is restored by the same version of Shipkeep or a later one only', async () => {
    const { identity, key } = await pair();
    const sealed = await archive(key);
    await expect(
      openArchive({
        identity,
        archive: stream(sealed),
        name: NAME,
        migrations: ['20261121130000_user_display_name'],
      }),
    ).rejects.toThrow('newer version of Shipkeep');
  });

  // #439: whoever can write where archives are kept cannot pass an older archive of the same
  // server for the one asked for.
  it('refuses another archive of the same server put under the name asked for', async () => {
    const { identity, key } = await pair();
    const older = await archive(key, dump(), 'shipkeep-20261101-100000-0badc0de.age');
    await expect(
      openArchive({ identity, archive: stream(older), name: NAME, migrations: [MIGRATION] }),
    ).rejects.toThrow(
      'This archive was created as shipkeep-20261101-100000-0badc0de.age, not shipkeep-20261123-100000-3f9a1c2e.age: it is not restored.',
    );
    await expect(
      createArchive({
        key,
        kek,
        migration: MIGRATION,
        now: NOW,
        name: '../kek.age',
        dump: stream(dump()),
      }),
    ).rejects.toThrow('ending in .age');
  });

  it('still opens an archive made before names, and never a name taken off a newer one', async () => {
    const { identity, key } = await pair();
    const fields = {
      format: 'shipkeep-instance-backup',
      version: 1,
      createdAt: NOW.toISOString(),
      migration: MIGRATION,
      kek: Buffer.from(kek).toString('base64'),
    };
    // The tag of version 1: its fields, one per line, without a name.
    const v1 = createHmac('sha256', key.authentication)
      .update([fields.format, '1', fields.createdAt, fields.migration, fields.kek].join('\n'))
      .digest('base64');
    const opened = await openArchive({
      identity,
      archive: stream(await sealed(key.recipient, { ...fields, authentication: v1 })),
      name: NAME,
      migrations: [MIGRATION],
    });
    expect(opened.manifest).toMatchObject({ version: 1, createdAt: NOW.toISOString() });
    expect(await collect(opened.dump)).toEqual(dump());

    // A version 2 manifest without its name, passed as version 1, keeps a tag that covers the name.
    const v2 = createHmac('sha256', key.authentication)
      .update([fields.format, '2', fields.createdAt, fields.migration, fields.kek, NAME].join('\n'))
      .digest('base64');
    await expect(
      openArchive({
        identity,
        archive: stream(await sealed(key.recipient, { ...fields, authentication: v2 })),
        name: NAME,
        migrations: [MIGRATION],
      }),
    ).rejects.toThrow('was not made by a server that backs up to this identity');
  });

  it('takes a backup key, and a custom-format dump only', async () => {
    const { key } = await pair();
    for (const broken of [
      { recipient: 'AGE-SECRET-KEY-1x', authentication: key.authentication },
      { recipient: key.recipient, authentication: new Uint8Array(16) },
    ])
      await expect(
        createArchive({
          key: broken,
          kek,
          migration: MIGRATION,
          now: NOW,
          name: NAME,
          dump: stream(dump()),
        }),
      ).rejects.toThrow('./backup.sh keygen');
    const plain = new TextEncoder().encode('-- PostgreSQL database dump\nCREATE TABLE x();\n');
    await expect(archive(key, plain)).rejects.toThrow('not a pg_dump archive in custom format');
    await expect(archive(key, new Uint8Array(0))).rejects.toThrow('empty or cut short');
  });

  it('derives the backup key from the identity, and never the identity from it', async () => {
    const { identity, key } = await pair();
    expect(await backupKeyFor(identity)).toEqual(key);
    expect(key.authentication).toHaveLength(32);
    expect((await pair()).key.authentication).not.toEqual(key.authentication);
    const text = JSON.stringify({
      ...key,
      authentication: Buffer.from(key.authentication).toString('base64'),
    });
    expect(text).not.toContain(identity.slice('AGE-SECRET-KEY-1'.length));
    await expect(backupKeyFor('age1notanidentity')).rejects.toThrow(BackupRefusal);
  });

  it('reads an identity file, comments included, followed by the archive', async () => {
    const { identity, key } = await pair();
    const { recipient } = key;
    const sealed = await archive(key);
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
    expect(parseBackupCommand(['create', NAME])).toEqual({ action: 'backup-create', name: NAME });
    expect(parseBackupCommand(['verify', NAME])).toEqual({ action: 'backup-verify', name: NAME });
    expect(parseBackupCommand(['restore-database', NAME])).toEqual({
      action: 'backup-restore-database',
      name: NAME,
    });
    expect(parseBackupCommand(['restore-key', '--replace-this-installation', NAME])).toEqual({
      action: 'backup-restore-key',
      name: NAME,
    });
    for (const argv of [
      [],
      ['create'],
      ['verify'],
      ['verify', '../kek.age'],
      ['restore-database'],
      ['restore-key', '--replace-this-installation'],
      ['restore-key', NAME],
      ['restore-key', '--yes', NAME],
      ['create', '../kek.age'],
      ['create', '/var/lib/shipkeep/kek.age'],
      ['create', 'shipkeep.tar'],
      ['restore-database', `${NAME}\n`],
      ['restore-database', '-x.age'],
      ['create', NAME, 'extra'],
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
    action:
      | 'backup-keygen'
      | 'backup-create'
      | 'backup-verify'
      | 'backup-restore-database'
      | 'backup-restore-key',
    input: Uint8Array,
    env: Record<string, string>,
    name = NAME,
  ) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => out.push(chunk));
    stderr.on('data', (chunk: Buffer) => err.push(chunk));
    stdin.end(Buffer.from(input));
    await runBackup(action === 'backup-keygen' ? { action } : { action, name }, {
      stdin,
      stdout,
      stderr,
      env,
      now: NOW,
    });
    return { out: new Uint8Array(Buffer.concat(out)), err: Buffer.concat(err).toString() };
  }

  /** A server's keys volume and migrations, as the backup container sees them. */
  async function server() {
    const directory = await mkdtemp(join(tmpdir(), 'backup-'));
    const migrations = join(directory, 'migrations');
    await mkdir(join(migrations, MIGRATION), { recursive: true });
    const kekFile = join(directory, 'kek');
    await writeFile(kekFile, Buffer.from(kek), { mode: 0o400 });
    return {
      directory,
      kekFile,
      backupKeyFile: join(directory, 'backup-key'),
      env: {
        SHIPKEEP_KEK_FILE: kekFile,
        SHIPKEEP_MIGRATIONS_DIR: migrations,
        SHIPKEEP_BACKUP_KEY_FILE: join(directory, 'backup-key'),
      },
    };
  }

  /** A fresh installation: its own key, and no backup key yet. */
  async function reinstall(at: Awaited<ReturnType<typeof server>>) {
    await rm(at.kekFile, { force: true });
    await rm(at.backupKeyFile, { force: true });
    await writeFile(at.kekFile, Buffer.alloc(32, 7), { mode: 0o400 });
  }

  it('creates a backup, then restores the database and the key from it', async () => {
    const at = await server();
    await expect(run('backup-create', dump(), at.env)).rejects.toThrow(
      'This server has no backup key: create one with ./backup.sh keygen.',
    );

    const generated = await run('backup-keygen', new Uint8Array(0), at.env);
    const identityFile = generated.out;
    expect(generated.err).toContain('keep it off this server');
    // The server keeps the public key and the authentication key, read-only, not the identity.
    const identity =
      /^(AGE-SECRET-KEY-1\S+)$/m.exec(Buffer.from(identityFile).toString())?.[1] ?? '';
    expect(await readBackupKey(at.backupKeyFile)).toEqual(await backupKeyFor(identity));
    const written = await open(at.backupKeyFile, 'r');
    try {
      expect((await written.stat()).mode & 0o777).toBe(0o400);
      expect(await written.readFile('utf8')).not.toContain('AGE-SECRET-KEY');
    } finally {
      await written.close();
    }

    const data = dump();
    const created = await run('backup-create', data, at.env);
    const input = new Uint8Array(Buffer.concat([identityFile, created.out]));
    // What backup.sh restore checks first: the whole archive, which writes nothing.
    const verified = await run('backup-verify', input, at.env);
    expect(verified.out).toHaveLength(0);
    expect(verified.err).toBe(`The archive is ${NAME}, created at 2026-11-23T10:00:00.000Z.\n`);
    const restored = await run('backup-restore-database', input, at.env);
    expect(restored.out).toEqual(data);

    // A fresh installation has its own key: restoring puts the backup's in its place, and backs up
    // to the same identity again.
    await reinstall(at);
    const key = await run('backup-restore-key', input, at.env);
    expect(new Uint8Array(await readFile(at.kekFile))).toEqual(kek);
    expect(await readBackupKey(at.backupKeyFile)).toEqual(await backupKeyFor(identity));
    expect(key.err).toContain(
      'Key-encryption key restored from the backup of 2026-11-23T10:00:00.000Z',
    );
  });

  it('leaves the key as it was when the archive is damaged, even near its end', async () => {
    const at = await server();
    const identityFile = (await run('backup-keygen', new Uint8Array(0), at.env)).out;
    const sealed = (await run('backup-create', dump(), at.env)).out;
    const changed = sealed.slice();
    changed[changed.length - 10] = (changed[changed.length - 10] ?? 0) ^ 1;
    await reinstall(at);
    for (const action of ['backup-verify', 'backup-restore-key'] as const)
      await expect(
        run(action, new Uint8Array(Buffer.concat([identityFile, changed])), at.env),
      ).rejects.toThrow('The archive is damaged or was changed');
    expect(await readFile(at.kekFile)).toEqual(Buffer.alloc(32, 7));
    const names = await readdir(at.directory);
    expect(names.filter((name) => name.startsWith('kek.'))).toEqual([]);
    expect(names).not.toContain('backup-key');
  });

  it('restores nothing from an archive another server made to the same public key', async () => {
    const at = await server();
    const identityFile = (await run('backup-keygen', new Uint8Array(0), at.env)).out;
    const genuine = await readBackupKey(at.backupKeyFile);
    const forger = await server();
    await writeBackupKeyFile(forger.backupKeyFile, {
      recipient: genuine.recipient,
      authentication: (await pair()).key.authentication,
    });
    const forged = (await run('backup-create', dump(), forger.env)).out;
    await reinstall(at);
    const input = new Uint8Array(Buffer.concat([identityFile, forged]));
    for (const action of ['backup-restore-database', 'backup-restore-key'] as const)
      await expect(run(action, input, at.env)).rejects.toThrow(
        'was not made by a server that backs up to this identity',
      );
    expect(await readFile(at.kekFile)).toEqual(Buffer.alloc(32, 7));
  });

  // #439's acceptance: restoring s3:A while the storage serves archive B under that name is
  // refused before anything changes.
  it('restores nothing from an archive of this server served under another name', async () => {
    const at = await server();
    const identityFile = (await run('backup-keygen', new Uint8Array(0), at.env)).out;
    const older = 'shipkeep-20261101-100000-0badc0de.age';
    const served = (await run('backup-create', dump(), at.env, older)).out;
    await reinstall(at);
    const input = new Uint8Array(Buffer.concat([identityFile, served]));
    for (const action of [
      'backup-verify',
      'backup-restore-database',
      'backup-restore-key',
    ] as const)
      await expect(run(action, input, at.env, NAME)).rejects.toThrow(
        `This archive was created as ${older}, not ${NAME}: it is not restored.`,
      );
    expect(await readFile(at.kekFile)).toEqual(Buffer.alloc(32, 7));
    expect(await readdir(at.directory)).not.toContain('backup-key');
    // Under its own name, it is the archive it says it is.
    expect((await run('backup-restore-database', input, at.env, older)).out).toEqual(dump());
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
        { action: 'backup-create', name: NAME },
        { stdin: terminal, stdout: pipe, stderr: pipe, env: {}, now: NOW },
      ),
    ).rejects.toThrow('Standard input is the database dump');
  });
});
