// The S3 destination of instance backups (ADR 0026, M5.4b). These commands run in their own
// container, apart from the one that encrypts: they move archives that are already encrypted, and
// never see the key-encryption key or anything in clear. Any S3-compatible storage works.

import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Secret } from '@shipkeep/domain';

import { ARCHIVE_NAME, BackupRefusal } from './instance-backup';

/** An archive name in the bucket: what `backup.sh create --s3` names, or a name you chose. */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX = /^([A-Za-z0-9._-]+\/){0,8}$/;
const REGION = /^[a-z0-9-]{1,32}$/;
/** Parts of 16 MiB: up to 10 000 of them, so archives of 160 GiB. */
const PART_BYTES = 16 * 1024 * 1024;

export interface S3Settings {
  readonly bucket: string;
  readonly prefix: string;
  readonly region: string;
  /** Unset for AWS itself; the URL of any other S3-compatible storage. */
  readonly endpoint: string | undefined;
  readonly accessKeyId: Secret;
  readonly secretAccessKey: Secret;
}

/**
 * The destination, from `.env` (SHIPKEEP_BACKUP_S3_*). HTTPS only: the archive is encrypted, but
 * the requests carry the access key id, and an attacker in the path could drop a backup unseen.
 * Plain HTTP is accepted only when said explicitly, for a storage on the same machine.
 */
export function s3Settings(env: Readonly<Record<string, string | undefined>>): S3Settings {
  const bucket = env['SHIPKEEP_BACKUP_S3_BUCKET'] ?? '';
  if (!BUCKET.test(bucket))
    throw new BackupRefusal('SHIPKEEP_BACKUP_S3_BUCKET is not set to a bucket name.');
  const prefix = env['SHIPKEEP_BACKUP_S3_PREFIX'] ?? 'shipkeep/';
  if (!PREFIX.test(prefix) || prefix.split('/').some((part) => part === '..' || part === '.'))
    throw new BackupRefusal(
      'SHIPKEEP_BACKUP_S3_PREFIX is a folder path ending with /, such as shipkeep/.',
    );
  const region = env['SHIPKEEP_BACKUP_S3_REGION'] || 'us-east-1';
  if (!REGION.test(region)) throw new BackupRefusal('SHIPKEEP_BACKUP_S3_REGION is not a region.');
  const endpoint = env['SHIPKEEP_BACKUP_S3_ENDPOINT'] || undefined;
  if (endpoint !== undefined) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new BackupRefusal('SHIPKEEP_BACKUP_S3_ENDPOINT is not a URL.');
    }
    const plain = url.protocol === 'http:' && env['SHIPKEEP_BACKUP_S3_ALLOW_HTTP'] === 'true';
    if ((url.protocol !== 'https:' && !plain) || url.username || url.password || url.search)
      throw new BackupRefusal(
        'SHIPKEEP_BACKUP_S3_ENDPOINT must be an https:// URL without credentials in it.',
      );
  }
  const accessKeyId = env['SHIPKEEP_BACKUP_S3_ACCESS_KEY_ID'] ?? '';
  const secretAccessKey = env['SHIPKEEP_BACKUP_S3_SECRET_ACCESS_KEY'] ?? '';
  if (!accessKeyId || !secretAccessKey)
    throw new BackupRefusal(
      'Set SHIPKEEP_BACKUP_S3_ACCESS_KEY_ID and SHIPKEEP_BACKUP_S3_SECRET_ACCESS_KEY in .env.',
    );
  return {
    bucket,
    prefix,
    region,
    endpoint,
    accessKeyId: new Secret(accessKeyId),
    secretAccessKey: new Secret(secretAccessKey),
  };
}

function client(settings: S3Settings): S3Client {
  return new S3Client({
    region: settings.region,
    ...(settings.endpoint ? { endpoint: settings.endpoint, forcePathStyle: true } : {}),
    credentials: {
      accessKeyId: settings.accessKeyId.expose(),
      secretAccessKey: settings.secretAccessKey.expose(),
    },
    // An upload is checked end to end by age itself; the default checksums stay on.
    maxAttempts: 4,
  });
}

function key(settings: S3Settings, name: string): string {
  if (!ARCHIVE_NAME.test(name))
    throw new BackupRefusal('An archive name is letters, digits, . _ - and ends with .age.');
  return `${settings.prefix}${name}`;
}

/**
 * Copies standard input to a new object; an existing one is never replaced. The check before is
 * for a clear refusal; the write itself is conditional (`If-None-Match: *`, on the single request
 * or on the completion of a multipart upload), so two uploads of one name cannot both succeed.
 */
export async function upload(settings: S3Settings, name: string, input: Readable): Promise<void> {
  const s3 = client(settings);
  const target = key(settings, name);
  const taken = new BackupRefusal(`${name} is already in the bucket: choose another name.`);
  try {
    if (await exists(s3, settings.bucket, target)) throw taken;
    await new Upload({
      client: s3,
      params: {
        Bucket: settings.bucket,
        Key: target,
        Body: input,
        ContentType: 'application/octet-stream',
        IfNoneMatch: '*',
      },
      partSize: PART_BYTES,
      queueSize: 2,
      // A failed upload leaves no part behind to pay for.
      leavePartsOnError: false,
    }).done();
  } catch (error: unknown) {
    // 412: the object appeared since the check. 409: another conditional write of it is under way.
    if (
      error instanceof S3ServiceException &&
      (error.$metadata.httpStatusCode === 412 || error.$metadata.httpStatusCode === 409)
    )
      throw taken;
    throw refusal(error);
  } finally {
    s3.destroy();
  }
}

/** Writes an object to standard output. */
export async function download(
  settings: S3Settings,
  name: string,
  output: Writable,
): Promise<void> {
  const s3 = client(settings);
  try {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: settings.bucket, Key: key(settings, name) }),
    );
    if (!(object.Body instanceof Readable)) throw new BackupRefusal('The storage sent no body.');
    await pipeline(object.Body, output);
  } catch (error: unknown) {
    throw refusal(error);
  } finally {
    s3.destroy();
  }
}

/** The archives under the prefix, oldest first: name, size in bytes, time. */
export async function list(
  settings: S3Settings,
): Promise<{ name: string; bytes: number; at: string }[]> {
  const s3 = client(settings);
  const found: { name: string; bytes: number; at: string }[] = [];
  try {
    let token: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: settings.bucket,
          Prefix: settings.prefix,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) {
        const name = object.Key?.slice(settings.prefix.length) ?? '';
        if (ARCHIVE_NAME.test(name))
          found.push({
            name,
            bytes: object.Size ?? 0,
            at: object.LastModified?.toISOString() ?? '',
          });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  } catch (error: unknown) {
    throw refusal(error);
  } finally {
    s3.destroy();
  }
  return found.sort((a, b) => a.at.localeCompare(b.at) || a.name.localeCompare(b.name));
}

/**
 * Deletes the archive an interrupted `create --s3` stored: its pipeline failed after the upload had
 * taken what it was given. Deleting an absent object succeeds.
 */
export async function discard(settings: S3Settings, name: string): Promise<void> {
  const s3 = client(settings);
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: key(settings, name) }));
  } catch (error: unknown) {
    throw refusal(error);
  } finally {
    s3.destroy();
  }
}

/**
 * Tests the destination as a backup uses it (SPEC 10, credentials tested on save): the bucket
 * answers, and an object can be written then deleted under the prefix.
 */
export async function check(settings: S3Settings): Promise<void> {
  const s3 = client(settings);
  const probe = `${settings.prefix}.shipkeep-check-${String(Date.now())}`;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: settings.bucket }));
    await s3.send(new PutObjectCommand({ Bucket: settings.bucket, Key: probe, Body: 'check' }));
    await s3.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: probe }));
  } catch (error: unknown) {
    throw refusal(error);
  } finally {
    s3.destroy();
  }
}

async function exists(s3: S3Client, bucket: string, target: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: target }));
    return true;
  } catch (error: unknown) {
    if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return false;
    throw error;
  }
}

/** What went wrong, in fixed words: never the storage's own text, which may quote a request. */
function refusal(error: unknown): BackupRefusal {
  if (error instanceof BackupRefusal) return error;
  if (error instanceof S3ServiceException) {
    const status = error.$metadata.httpStatusCode;
    if (status === 401 || status === 403)
      return new BackupRefusal('The S3 storage refused the credentials, or this bucket to them.');
    if (status === 404) return new BackupRefusal('The S3 storage has no such bucket or archive.');
    return new BackupRefusal(`The S3 storage answered with an error (HTTP ${String(status)}).`);
  }
  return new BackupRefusal('The S3 storage cannot be reached: check the endpoint and the network.');
}
