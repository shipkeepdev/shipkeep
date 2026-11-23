import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * An S3-compatible storage for the backup destination tests: Versity's gateway (Apache-2.0), small
 * and complete enough for multipart uploads. Pinned by digest like every image.
 */
export const S3_TEST_IMAGE =
  'versity/versitygw:v1.10.0@sha256:89cad13cc981986ee284cbafea4613f9533ce6fd5f37a2c96c4c4fb8adb3a316';
const ACCESS = 'testaccess';
const SECRET = 'testsecret-testsecret';

/**
 * A storage for one spec file, with an empty bucket: S3_TEST_ENDPOINT (started with the access
 * and secret above) where Docker is out of reach, otherwise a container.
 */
export async function s3Storage(bucket: string): Promise<{
  env: Record<string, string>;
  stop: () => Promise<void>;
}> {
  let endpoint = process.env['S3_TEST_ENDPOINT'];
  let container: StartedTestContainer | undefined;
  if (!endpoint) {
    container = await new GenericContainer(S3_TEST_IMAGE)
      .withCommand(['--access', ACCESS, '--secret', SECRET, 'posix', '/tmp'])
      .withExposedPorts(7070)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    endpoint = `http://${container.getHost()}:${String(container.getMappedPort(7070))}`;
  }
  const s3 = new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
  });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  s3.destroy();
  return {
    env: {
      SHIPKEEP_BACKUP_S3_ENDPOINT: endpoint,
      // The test storage answers plain HTTP on the test machine.
      SHIPKEEP_BACKUP_S3_ALLOW_HTTP: 'true',
      SHIPKEEP_BACKUP_S3_BUCKET: bucket,
      SHIPKEEP_BACKUP_S3_PREFIX: 'shipkeep/',
      SHIPKEEP_BACKUP_S3_ACCESS_KEY_ID: ACCESS,
      SHIPKEEP_BACKUP_S3_SECRET_ACCESS_KEY: SECRET,
    },
    stop: async () => {
      await container?.stop();
    },
  };
}
