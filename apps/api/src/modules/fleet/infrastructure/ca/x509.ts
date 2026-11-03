import 'reflect-metadata';

import { createHash, webcrypto, X509Certificate } from 'node:crypto';

import * as x509 from '@peculiar/x509';

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

// Node's WebCrypto implementation drives every signature. The library types its provider with the
// browser Crypto interface, which Node's object satisfies at runtime. It is passed explicitly to
// every call so the result never depends on which copy of the library a bundler loaded.
const nodeCrypto = webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0];
x509.cryptoProvider.set(nodeCrypto);

/** Every Shipkeep certificate and key uses Ed25519 (SPEC section 3.2). */
export const SIGNING_ALGORITHM = { name: 'Ed25519' } as const;
export const CA_SUBJECT = 'CN=Shipkeep Installation CA';
export const CA_VALIDITY_MS = 10 * 365 * 864e5;
export const NODE_CERT_VALIDITY_MS = 30 * 864e5;
const SERIAL_BYTES = 16;

export interface KeyPairPem {
  publicKeyPem: string;
  /** PKCS#8 PEM. Treat as a secret. */
  privateKeyPem: string;
}

export async function generateEd25519KeyPair(): Promise<KeyPairPem> {
  const keys = (await webcrypto.subtle.generateKey(SIGNING_ALGORITHM, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return {
    publicKeyPem: toPem(
      'PUBLIC KEY',
      Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey)),
    ),
    privateKeyPem: toPem(
      'PRIVATE KEY',
      Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)),
    ),
  };
}

export async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  return webcrypto.subtle.importKey('pkcs8', fromPem(privateKeyPem), SIGNING_ALGORITHM, true, [
    'sign',
  ]);
}

export async function importPublicKey(publicKeyPem: string): Promise<CryptoKey> {
  return webcrypto.subtle.importKey('spki', fromPem(publicKeyPem), SIGNING_ALGORITHM, true, [
    'verify',
  ]);
}

export function randomSerial(): string {
  const bytes = Buffer.from(webcrypto.getRandomValues(new Uint8Array(SERIAL_BYTES)));
  // Clear the top bit: DER integers must stay positive.
  bytes[0] &= 0x7f;
  return bytes.toString('hex');
}

/** Creates the self-signed installation CA certificate. */
export async function createCaCertificate(keys: KeyPairPem, now: Date): Promise<string> {
  const publicKey = await importPublicKey(keys.publicKeyPem);
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: randomSerial(),
      name: CA_SUBJECT,
      notBefore: now,
      notAfter: new Date(now.getTime() + CA_VALIDITY_MS),
      signingAlgorithm: SIGNING_ALGORITHM,
      keys: { publicKey, privateKey: await importPrivateKey(keys.privateKeyPem) },
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
          true,
        ),
        await x509.SubjectKeyIdentifierExtension.create(publicKey, false, nodeCrypto),
      ],
    },
    nodeCrypto,
  );
  return cert.toString('pem');
}

export class CsrError extends Error {
  constructor(message: string) {
    super(`certificate request rejected: ${message}`);
    this.name = 'CsrError';
  }
}

/**
 * Parses and verifies a CSR. Only the public key is used afterwards; the subject and any
 * requested extension are ignored on purpose (the control plane decides every name).
 */
export async function verifyCsr(csrPem: string): Promise<CryptoKey> {
  let csr: x509.Pkcs10CertificateRequest;
  try {
    csr = new x509.Pkcs10CertificateRequest(csrPem);
  } catch {
    throw new CsrError('not a PEM encoded PKCS#10 request');
  }
  // The library types its WebCrypto objects with the browser lib, which this server build does not load.
  const algorithm = csr.publicKey.algorithm as { name: string };
  if (algorithm.name !== SIGNING_ALGORITHM.name) {
    throw new CsrError(`key algorithm must be ${SIGNING_ALGORITHM.name}`);
  }
  if (!(await csr.verify(nodeCrypto))) {
    throw new CsrError('signature does not verify');
  }
  return (await csr.publicKey.export(SIGNING_ALGORITHM, ['verify'], nodeCrypto)) as CryptoKey;
}

export interface NodeCertificateInput {
  caCertificatePem: string;
  caPrivateKeyPem: string;
  nodePublicKey: CryptoKey;
  nodeId: string;
  spiffeId: string;
  notBefore: Date;
  notAfter: Date;
  serial: string;
}

/** Signs a node client certificate: CN = node id, SAN URI = SPIFFE id, client auth only. */
export async function createNodeCertificate(input: NodeCertificateInput): Promise<string> {
  const ca = new x509.X509Certificate(input.caCertificatePem);
  const cert = await x509.X509CertificateGenerator.create(
    {
      serialNumber: input.serial,
      subject: `CN=${input.nodeId}`,
      issuer: ca.subject,
      notBefore: input.notBefore,
      notAfter: input.notAfter,
      signingAlgorithm: SIGNING_ALGORITHM,
      publicKey: input.nodePublicKey,
      signingKey: await importPrivateKey(input.caPrivateKeyPem),
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], true),
        new x509.SubjectAlternativeNameExtension([{ type: 'url', value: input.spiffeId }], true),
        await x509.AuthorityKeyIdentifierExtension.create(ca, false, nodeCrypto),
        await x509.SubjectKeyIdentifierExtension.create(input.nodePublicKey, false, nodeCrypto),
      ],
    },
    nodeCrypto,
  );
  return cert.toString('pem');
}

/** `sha256:<hex>` fingerprint of a PEM certificate's DER encoding. */
export function certificateFingerprint(certificatePem: string): string {
  const der = new X509Certificate(certificatePem).raw;
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

export function toPem(label: string, der: Buffer): string {
  const body = der.toString('base64').replace(/(.{64})(?=.)/g, '$1\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export function fromPem(pem: string): Buffer {
  const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '');
  return Buffer.from(body, 'base64');
}
