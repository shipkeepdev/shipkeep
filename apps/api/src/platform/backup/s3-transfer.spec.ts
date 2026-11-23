import { parseBackupCommand, BackupUsageError } from './backup-commands';
import { s3Settings } from './s3-transfer';

const env = {
  SHIPKEEP_BACKUP_S3_BUCKET: 'acme-backups',
  SHIPKEEP_BACKUP_S3_ACCESS_KEY_ID: 'AKIAFAKEEXAMPLE',
  SHIPKEEP_BACKUP_S3_SECRET_ACCESS_KEY: 'fake-secret-for-tests',
};

describe('S3 destination settings (ADR 0026)', () => {
  it('reads AWS defaults, or any S3-compatible storage over HTTPS', () => {
    expect(s3Settings(env)).toMatchObject({
      bucket: 'acme-backups',
      prefix: 'shipkeep/',
      region: 'us-east-1',
      endpoint: undefined,
    });
    expect(
      s3Settings({
        ...env,
        SHIPKEEP_BACKUP_S3_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
        SHIPKEEP_BACKUP_S3_REGION: 'eu-central-003',
      }),
    ).toMatchObject({
      endpoint: 'https://s3.eu-central-003.backblazeb2.com',
      region: 'eu-central-003',
    });
    // The secret never shows in the settings as text.
    expect(JSON.stringify(s3Settings(env))).not.toContain('fake-secret-for-tests');
  });

  it('refuses what would leak a request or write outside the prefix', () => {
    for (const [name, change] of [
      ['plain HTTP', { SHIPKEEP_BACKUP_S3_ENDPOINT: 'http://s3.example.com' }],
      [
        'credentials in the URL',
        { SHIPKEEP_BACKUP_S3_ENDPOINT: 'https://key:secret@s3.example.com' },
      ],
      ['a query', { SHIPKEEP_BACKUP_S3_ENDPOINT: 'https://s3.example.com/?x=1' }],
      ['another scheme', { SHIPKEEP_BACKUP_S3_ENDPOINT: 'file:///etc' }],
      ['no bucket', { SHIPKEEP_BACKUP_S3_BUCKET: '' }],
      ['a bucket path', { SHIPKEEP_BACKUP_S3_BUCKET: 'acme/../x' }],
      ['a prefix going up', { SHIPKEEP_BACKUP_S3_PREFIX: '../other/' }],
      ['a prefix without slash', { SHIPKEEP_BACKUP_S3_PREFIX: 'shipkeep' }],
      ['no secret', { SHIPKEEP_BACKUP_S3_SECRET_ACCESS_KEY: '' }],
    ] as const)
      expect(() => s3Settings({ ...env, ...change }), name).toThrow();
    // Plain HTTP only when said, for a storage on the same machine.
    expect(
      s3Settings({
        ...env,
        SHIPKEEP_BACKUP_S3_ENDPOINT: 'http://127.0.0.1:7070',
        SHIPKEEP_BACKUP_S3_ALLOW_HTTP: 'true',
      }).endpoint,
    ).toBe('http://127.0.0.1:7070');
  });

  it('reads the transfer commands, with archive names only', () => {
    expect(parseBackupCommand(['upload', 'shipkeep-20261123-100000.age'])).toEqual({
      action: 'backup-upload',
      name: 'shipkeep-20261123-100000.age',
    });
    expect(parseBackupCommand(['download', 'mine.age'])).toEqual({
      action: 'backup-download',
      name: 'mine.age',
    });
    expect(parseBackupCommand(['discard', 'mine.age'])).toEqual({
      action: 'backup-discard',
      name: 'mine.age',
    });
    expect(parseBackupCommand(['list'])).toEqual({ action: 'backup-list' });
    expect(parseBackupCommand(['check'])).toEqual({ action: 'backup-check' });
    for (const argv of [
      ['upload'],
      ['upload', '../etc/passwd.age'],
      ['upload', 'archive.tar'],
      ['download', '.age'],
      ['discard', 'a/b.age'],
      ['list', 'extra'],
    ])
      expect(() => parseBackupCommand(argv), JSON.stringify(argv)).toThrow(BackupUsageError);
  });
});
