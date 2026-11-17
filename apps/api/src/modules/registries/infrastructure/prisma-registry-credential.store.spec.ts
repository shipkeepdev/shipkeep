import { ConflictError } from '@shipkeep/domain';

import { DecryptionError, ValueDecryptionError } from '../../../platform/crypto/envelope';
import type { EnvelopeService } from '../../../platform/crypto/envelope.service';
import type { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';

import { PrismaRegistryCredentialStore } from './prisma-registry-credential.store';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const row = {
  id: '0190f5a8-7b1c-7e2d-8f3a-0000000000e1',
  organizationId: ORG,
  server: 'ghcr.io',
  username: 'deploy-bot',
  passwordEnc: new Uint8Array([1, 2, 3]),
  version: 2,
};

function store(decryptFor: EnvelopeService['decryptFor']): PrismaRegistryCredentialStore {
  const database = {
    client: { registryCredential: { findFirst: () => Promise.resolve(row) } },
  } as unknown as PrismaUnitOfWork;
  return new PrismaRegistryCredentialStore(database, { decryptFor } as unknown as EnvelopeService);
}

/** What a deployment is told when it reads stored credentials (issue #325). */
describe('PrismaRegistryCredentialStore.login', () => {
  it('returns the login with the password it decrypted for this organization and registry', async () => {
    const asked: string[] = [];
    const login = await store((scope, purpose) => {
      asked.push(scope, purpose);
      return Promise.resolve(Buffer.from('sk_test_fake_registry_password'));
    }).login(ORG, 'ghcr.io');
    expect(asked).toEqual([`organization:${ORG}`, 'registry:ghcr.io:2']);
    expect(login).toMatchObject({ server: 'ghcr.io', username: 'deploy-bot' });
    expect(login?.password.expose()).toBe('sk_test_fake_registry_password');
  });

  it('says the credentials are unreadable when the stored value does not decrypt', async () => {
    await expect(
      store(() => Promise.reject(new ValueDecryptionError('authentication failed'))).login(
        ORG,
        'ghcr.io',
      ),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'registry_credentials_unreadable',
      message: 'The stored credentials for ghcr.io cannot be read; store them again.',
    });
  });

  it('lets every other failure through, so that the deployment is retried', async () => {
    // The database that holds the data key, a key-encryption key that is not loaded, a data key
    // that cannot be unwrapped: storing the credentials again would not help any of them.
    for (const failure of [
      new Error('connection lost'),
      new Error('key-encryption key not loaded yet'),
      new DecryptionError('authentication failed'),
    ])
      await expect(store(() => Promise.reject(failure)).login(ORG, 'ghcr.io')).rejects.toBe(
        failure,
      );
  });
});
