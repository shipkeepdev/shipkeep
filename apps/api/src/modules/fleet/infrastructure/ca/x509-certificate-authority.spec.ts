import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as x509 from '@peculiar/x509';

import type { AppConfig } from '../../../../platform/config/app-config';
import { EnvelopeService } from '../../../../platform/crypto/envelope.service';
import {
  MemoryDataKeyStore,
  MemoryInstallationKeyStore as MemoryInstallationKeys,
} from '../../../../testing/memory-stores';

import {
  CsrError,
  generateEd25519KeyPair,
  importPrivateKey,
  importPublicKey,
  SIGNING_ALGORITHM,
} from './x509';
import { X509CertificateAuthority } from './x509-certificate-authority';

async function envelope(): Promise<EnvelopeService> {
  const path = join(await mkdtemp(join(tmpdir(), 'shipkeep-ca-')), 'kek');
  await writeFile(path, randomBytes(32), { mode: 0o400 });
  const service = new EnvelopeService(
    { get: () => path } as unknown as AppConfig,
    new MemoryDataKeyStore(),
  );
  await service.onModuleInit();
  return service;
}

async function csrFor(keys = generateEd25519KeyPair()): Promise<string> {
  const pair = await keys;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=whatever-the-agent-claims',
    keys: {
      publicKey: await importPublicKey(pair.publicKeyPem),
      privateKey: await importPrivateKey(pair.privateKeyPem),
    },
    signingAlgorithm: SIGNING_ALGORITHM,
    extensions: [
      new x509.SubjectAlternativeNameExtension([
        { type: 'url', value: 'spiffe://shipkeep/evil/node/evil' },
      ]),
    ],
  });
  return csr.toString('pem');
}

const org = '0192f0c0-0000-7000-8000-0000000000aa';
const nodeId = '0192f0c0-0000-7000-8000-0000000000bb';

describe('X509CertificateAuthority', () => {
  it('creates the CA and confirmation keys once and stores private keys encrypted', async () => {
    const store = new MemoryInstallationKeys();
    const env = await envelope();
    const ca = new X509CertificateAuthority(store, env);
    await ca.onModuleInit();

    expect(store.keys.size).toBe(2);
    const caKey = store.keys.get('ca');
    expect(caKey?.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(caKey?.privateKeyEnc.toString('utf8')).not.toContain('PRIVATE KEY');
    expect(store.keys.get('confirmation')?.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(await ca.caFingerprint()).toMatch(/^sha256:[0-9a-f]{64}$/);

    const parsed = new X509Certificate(await ca.caCertificatePem());
    expect(parsed.subject).toBe('CN=Shipkeep Installation CA');
    expect(parsed.ca).toBe(true);

    // A second start reuses the stored keys.
    const again = new X509CertificateAuthority(store, env);
    await again.onModuleInit();
    expect(store.inserts).toBe(2);
    expect(await again.caFingerprint()).toBe(await ca.caFingerprint());
  });

  it('issues a 30-day client certificate with the identity it decides, not the CSR', async () => {
    const ca = new X509CertificateAuthority(new MemoryInstallationKeys(), await envelope());
    await ca.onModuleInit();

    const issued = await ca.issueNodeCertificate(await csrFor(), { organizationId: org, nodeId });
    const cert = new X509Certificate(issued.certificatePem);
    const caCert = new X509Certificate(await ca.caCertificatePem());

    expect(cert.checkIssued(caCert)).toBe(true);
    expect(cert.verify(caCert.publicKey)).toBe(true);
    expect(cert.subject).toBe(`CN=${nodeId}`);
    expect(cert.subjectAltName).toBe(`URI:spiffe://shipkeep/${org}/node/${nodeId}`);
    expect(cert.subjectAltName).not.toContain('evil');
    expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.2'); // clientAuth
    expect(cert.ca).toBe(false);
    expect(issued.serial).toMatch(/^[0-9a-f]{32}$/);
    expect(cert.serialNumber.toLowerCase().replace(/^0+/, '')).toBe(
      issued.serial.replace(/^0+/, ''),
    );
    expect(issued.notAfter.getTime() - issued.notBefore.getTime()).toBe(30 * 864e5);
  });

  it('issues distinct serials and keeps the node public key', async () => {
    const ca = new X509CertificateAuthority(new MemoryInstallationKeys(), await envelope());
    await ca.onModuleInit();
    const keys = await generateEd25519KeyPair();
    const a = await ca.issueNodeCertificate(await csrFor(Promise.resolve(keys)), {
      organizationId: org,
      nodeId,
    });
    const b = await ca.issueNodeCertificate(await csrFor(Promise.resolve(keys)), {
      organizationId: org,
      nodeId,
    });
    expect(a.serial).not.toBe(b.serial);
    const pub = new X509Certificate(a.certificatePem).publicKey.export({
      type: 'spki',
      format: 'pem',
    });
    expect(String(pub).replace(/\s/g, '')).toBe(keys.publicKeyPem.replace(/\s/g, ''));
  });

  it('rejects malformed, forged and non-Ed25519 requests', async () => {
    const ca = new X509CertificateAuthority(new MemoryInstallationKeys(), await envelope());
    await ca.onModuleInit();
    const identity = { organizationId: org, nodeId };

    await expect(ca.issueNodeCertificate('garbage', identity)).rejects.toThrow(CsrError);
    await expect(
      ca.issueNodeCertificate(
        '-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----',
        identity,
      ),
    ).rejects.toThrow(CsrError);

    // Tamper with the signature bytes of a valid CSR.
    const valid = await csrFor();
    const lines = valid.trim().split('\n');
    const lastBody = lines.length - 2;
    const line = lines[lastBody] ?? '';
    lines[lastBody] = `${line.slice(0, -5)}${line.endsWith('AAAA=') ? 'BBBB=' : 'AAAA='}`;
    await expect(ca.issueNodeCertificate(lines.join('\n'), identity)).rejects.toThrow(CsrError);

    // A request signed with an RSA key.
    const { webcrypto } = await import('node:crypto');
    const rsa = await webcrypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const rsaCsr = await x509.Pkcs10CertificateRequestGenerator.create({
      name: 'CN=rsa',
      keys: rsa,
      signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    });
    await expect(ca.issueNodeCertificate(rsaCsr.toString('pem'), identity)).rejects.toThrow(
      /Ed25519/,
    );
  });

  it('refuses to operate before initialization', async () => {
    const ca = new X509CertificateAuthority(new MemoryInstallationKeys(), await envelope());
    await expect(ca.caCertificatePem()).rejects.toThrow(/not loaded/);
    await expect(ca.publicKeyPem()).rejects.toThrow(/not loaded/);
  });

  it('issues separate server-only credentials for DNS names and IP addresses', async () => {
    const ca = new X509CertificateAuthority(new MemoryInstallationKeys(), await envelope());
    await ca.onModuleInit();
    const root = new X509Certificate(await ca.caCertificatePem());
    for (const host of ['gateway.example.com', '127.0.0.1']) {
      const credentials = await ca.gatewayCredentials(host);
      const leaf = new X509Certificate(credentials.cert);
      expect(leaf.verify(root.publicKey)).toBe(true);
      expect(leaf.ca).toBe(false);
      expect(leaf.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
      expect(host === '127.0.0.1' ? leaf.checkIP(host) : leaf.checkHost(host)).toBe(host);
      expect(JSON.stringify(credentials)).not.toContain('PRIVATE KEY');
    }
  });
});
