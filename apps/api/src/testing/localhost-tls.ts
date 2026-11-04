import { webcrypto } from 'node:crypto';

import * as x509 from '@peculiar/x509';

/** Ephemeral loopback certificate and in-memory key for isolated HTTPS/SMTP tests. */
export async function localhostTls(): Promise<{ key: string; cert: string }> {
  const crypto = webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0];
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      name: 'CN=localhost',
      keys,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      notBefore: new Date(Date.now() - 60000),
      notAfter: new Date(Date.now() + 3600000),
      extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'localhost' }])],
    },
    crypto,
  );
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const label = 'PRIVATE KEY';
  const key = `-----BEGIN ${label}-----\n${
    der
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n') ?? ''
  }\n-----END ${label}-----\n`;
  return { key, cert: cert.toString('pem') };
}
