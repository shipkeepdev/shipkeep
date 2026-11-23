import { randomBytes } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';

import { s3Storage } from '../../testing/s3-storage';

import { runBackup } from './backup-commands';
import { BackupRefusal } from './instance-backup';
import { check, discard, download, list, s3Settings, upload } from './s3-transfer';

/** ADR 0026, M5.4b: the S3 destination against a real S3-compatible storage. */
describe('instance backups in an S3 destination', () => {
  let storage: Awaited<ReturnType<typeof s3Storage>>;

  beforeAll(async () => {
    storage = await s3Storage(`shipkeep-backups-${randomBytes(4).toString('hex')}`);
  });
  afterAll(async () => {
    await storage.stop();
  });

  async function fetch(name: string): Promise<Buffer> {
    const out = new PassThrough();
    const parts: Buffer[] = [];
    out.on('data', (part: Buffer) => parts.push(part));
    await download(s3Settings(storage.env), name, out);
    return Buffer.concat(parts);
  }

  it('stores an archive in parts, lists it, gives it back, and never replaces it', async () => {
    const settings = s3Settings(storage.env);
    await check(settings);
    // Over 16 MiB: a multipart upload of two parts.
    const archive = randomBytes(20 * 1024 * 1024);
    await upload(settings, 'shipkeep-20261123-100000.age', Readable.from([archive]));
    expect((await fetch('shipkeep-20261123-100000.age')).equals(archive)).toBe(true);
    expect(await list(settings)).toEqual([
      { name: 'shipkeep-20261123-100000.age', bytes: archive.length, at: expect.any(String) },
    ]);
    await expect(
      upload(settings, 'shipkeep-20261123-100000.age', Readable.from([Buffer.from('other')])),
    ).rejects.toThrow('already in the bucket');
    expect((await fetch('shipkeep-20261123-100000.age')).equals(archive)).toBe(true);
    // An interrupted backup is discarded; discarding what is not there succeeds.
    await discard(settings, 'shipkeep-20261123-100000.age');
    await discard(settings, 'shipkeep-20261123-100000.age');
    expect(await list(settings)).toEqual([]);
    // The check leaves nothing behind either.
    expect(await list(settings)).toEqual([]);
  });

  it('never replaces an archive, even when two uploads of one name pass the check together', async () => {
    const settings = s3Settings(storage.env);
    // Both bodies wait until both uploads have checked that the name is free.
    for (const size of [1024, 20 * 1024 * 1024]) {
      const name = `shipkeep-20261123-120000-${String(size)}.age`;
      let started = 0;
      let release: () => void = () => undefined;
      const together = new Promise<void>((resolve) => (release = resolve));
      const body = (fill: number) =>
        Readable.from(
          (async function* () {
            started += 1;
            if (started === 2) release();
            await together;
            yield Buffer.alloc(size, fill);
          })(),
        );
      const outcomes = await Promise.allSettled([
        upload(settings, name, body(1)),
        upload(settings, name, body(2)),
      ]);
      const stored = outcomes.findIndex((outcome) => outcome.status === 'fulfilled');
      expect(
        outcomes.filter((outcome) => outcome.status === 'fulfilled'),
        String(size),
      ).toHaveLength(1);
      const refused = outcomes.find((outcome) => outcome.status === 'rejected');
      expect(String(refused?.reason)).toContain('already in the bucket');
      expect((await fetch(name)).equals(Buffer.alloc(size, stored + 1))).toBe(true);
      await discard(settings, name);
    }
  });

  it('says what went wrong in fixed words, never the storage text', async () => {
    const wrong = s3Settings({
      ...storage.env,
      SHIPKEEP_BACKUP_S3_SECRET_ACCESS_KEY: 'not-the-secret',
    });
    await expect(check(wrong)).rejects.toThrow(
      'The S3 storage refused the credentials, or this bucket to them.',
    );
    await expect(fetch('missing.age')).rejects.toThrow('no such bucket or archive');
    const unreachable = s3Settings({
      ...storage.env,
      SHIPKEEP_BACKUP_S3_ENDPOINT: 'http://127.0.0.1:9',
    });
    await expect(check(unreachable)).rejects.toBeInstanceOf(BackupRefusal);
  });

  it('runs as the commands backup.sh calls', async () => {
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const said: Buffer[] = [];
    stderr.on('data', (part: Buffer) => said.push(part));
    stdin.end(Buffer.from('age-encryption.org/v1\n...'));
    const io = { stdin, stdout: new PassThrough(), stderr, env: storage.env, now: new Date() };
    await runBackup({ action: 'backup-upload', name: 'shipkeep-20261123-110000.age' }, io);
    expect(Buffer.concat(said).toString()).toContain('Uploaded shipkeep-20261123-110000.age.');
    expect((await fetch('shipkeep-20261123-110000.age')).toString()).toBe(
      'age-encryption.org/v1\n...',
    );
  });
});
