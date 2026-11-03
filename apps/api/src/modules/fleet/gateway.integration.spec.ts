import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Code, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import type { INestApplication } from '@nestjs/common';
import * as x509 from '@peculiar/x509';
import { AgentGatewayService } from '@shipkeep/proto-ts';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { applyMigrations } from '../../testing/apply-migrations';
import { resetDatabase } from '../../testing/reset-database';

import { IssueJoinToken } from './application/issue-join-token';
import {
  createCaCertificate,
  createNodeCertificate,
  generateEd25519KeyPair,
  importPrivateKey,
  importPublicKey,
  SIGNING_ALGORITHM,
  verifyCsr,
} from './infrastructure/ca/x509';
import { X509CertificateAuthority } from './infrastructure/ca/x509-certificate-authority';
import { AgentGateway } from './interface/agent-gateway';

const org = '0192f0c0-0000-7000-8000-0000000000ac';
const actor = { kind: 'user' as const, id: 'usr_test' };

async function* messages<T>(values: readonly T[]): AsyncGenerator<T> {
  for (const value of values) yield await Promise.resolve(value);
}

async function requestCertificate() {
  const keys = await generateEd25519KeyPair();
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=forged-identity',
    signingAlgorithm: SIGNING_ALGORITHM,
    keys: {
      publicKey: await importPublicKey(keys.publicKeyPem),
      privateKey: await importPrivateKey(keys.privateKeyPem),
    },
  });
  return { key: keys.privateKeyPem, csrPem: csr.toString('pem') };
}

describe('agent gateway over real HTTP/2 TLS and PostgreSQL', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer | undefined;
  let caPem: string;
  let baseUrl: string;

  function client(
    credentials?: { cert: string; key: string },
    trust = caPem,
    servername = 'localhost',
  ) {
    return createClient(
      AgentGatewayService,
      createGrpcTransport({
        baseUrl,
        nodeOptions: { ca: trust, servername, ...credentials },
        defaultTimeoutMs: 3000,
        idleConnectionTimeoutMs: 100,
      }),
    );
  }

  async function enroll(name: string) {
    const token = await app.get(IssueJoinToken).execute({ organizationId: org, actor });
    const request = await requestCertificate();
    const result = await client().enroll({
      joinToken: token.value,
      csrPem: request.csrPem,
      facts: { hostname: name },
      agentVersion: '0.1.0',
    });
    return { token, result, key: request.key, cert: result.certPem };
  }

  beforeAll(async () => {
    if (!process.env['DATABASE_URL']) {
      container = await new PostgreSqlContainer('postgres:17').start();
      process.env['DATABASE_URL'] = container.getConnectionUri();
    }
    await resetDatabase(process.env['DATABASE_URL']);
    await applyMigrations(
      process.env['DATABASE_URL'],
      resolve(__dirname, '../../../prisma/migrations'),
    );
    const path = join(await mkdtemp(join(tmpdir(), 'shipkeep-gateway-')), 'kek');
    await writeFile(path, randomBytes(32), { mode: 0o400 });
    process.env['SHIPKEEP_KEK_FILE'] = path;
    process.env['LOG_LEVEL'] = 'error';
    process.env['AGENT_GATEWAY_ADDR'] = '127.0.0.1:0';
    process.env['AGENT_GATEWAY_SERVER_NAME'] = 'localhost';
    const { createApp } = await import('../../bootstrap.js');
    app = await createApp();
    await app.init();
    caPem = await app.get(X509CertificateAuthority).caCertificatePem();
    const gateway = app.get(AgentGateway);
    await gateway.start();
    const address = gateway.address();
    if (!address || typeof address === 'string') throw new Error('gateway has no TCP listener');
    baseUrl = `https://localhost:${String(address.port)}`;
  });

  afterAll(async () => {
    await app.close();
    await container?.stop();
  });

  it('enrolls without a client certificate, exposes the pinned CA fingerprint and rejects reuse', async () => {
    const enrolled = await enroll('tls-enroll');
    const cert = new X509Certificate(enrolled.cert);
    expect(cert.verify(new X509Certificate(caPem).publicKey)).toBe(true);
    expect(cert.subjectAltName).toBe(`URI:spiffe://shipkeep/${org}/node/${enrolled.result.nodeId}`);
    expect(enrolled.token.caFingerprint).toBe(
      await app.get(X509CertificateAuthority).caFingerprint(),
    );
    await expect(
      client().enroll({
        joinToken: enrolled.token.value,
        csrPem: (await requestCertificate()).csrPem,
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  it('rejects missing certificates and spoofed identity headers on protected RPCs', async () => {
    await expect(
      client().renewCertificate(
        { csrPem: (await requestCertificate()).csrPem },
        { headers: { 'x-node-id': 'forged', 'x-client-cert': 'forged' } },
      ),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });
  });

  it('authenticates unfinished streaming methods before returning Unimplemented', async () => {
    const enrolled = await enroll('tls-stream-auth');
    const input = [{ msg: { case: 'hello' as const, value: { nodeId: enrolled.result.nodeId } } }];
    await expect(
      client().connect(messages(input))[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    await expect(
      client(enrolled).connect(messages(input))[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ code: Code.Unimplemented });
    await expect(
      client().execStream(messages([]))[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
  });

  it('renews with mTLS and rejects the old serial even over the same connection', async () => {
    const enrolled = await enroll('tls-renew');
    const current = client(enrolled);
    const request = await requestCertificate();
    const renewed = await current.renewCertificate({ csrPem: request.csrPem });
    expect(new X509Certificate(renewed.certPem).subject).toBe(`CN=${enrolled.result.nodeId}`);
    await expect(current.renewCertificate({ csrPem: request.csrPem })).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    await expect(
      client({ cert: renewed.certPem, key: request.key }).renewCertificate({
        csrPem: request.csrPem,
      }),
    ).resolves.toHaveProperty('certPem');
  });

  it('checks the revocation list on every call, not only at the TLS handshake', async () => {
    const enrolled = await enroll('tls-revoked');
    const current = client(enrolled);
    // A bad CSR exercises authentication but leaves the certificate current.
    await expect(current.renewCertificate({ csrPem: 'bad CSR' })).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    await app.get(PrismaService).nodeCertificate.updateMany({
      where: { nodeId: enrolled.result.nodeId },
      data: { revokedAt: new Date() },
    });
    await expect(current.renewCertificate({ csrPem: 'bad CSR' })).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
  });

  it('rejects a CA-signed certificate that was never registered', async () => {
    const request = await requestCertificate();
    const issued = await app.get(X509CertificateAuthority).issueNodeCertificate(request.csrPem, {
      organizationId: org,
      nodeId: '0192f0c0-0000-7000-8000-0000000000dd',
    });
    await expect(
      client({ cert: issued.certificatePem, key: request.key }).renewCertificate({
        csrPem: request.csrPem,
      }),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });
  });

  it('rejects a rogue CA even when the certificate copies a registered node identity and serial', async () => {
    const enrolled = await enroll('tls-rogue-ca');
    const request = await requestCertificate();
    const rogue = await generateEd25519KeyPair();
    const cert = await createNodeCertificate({
      caCertificatePem: await createCaCertificate(rogue, new Date()),
      caPrivateKeyPem: rogue.privateKeyPem,
      nodePublicKey: await verifyCsr(request.csrPem),
      nodeId: enrolled.result.nodeId,
      spiffeId: `spiffe://shipkeep/${org}/node/${enrolled.result.nodeId}`,
      notBefore: new Date(),
      notAfter: new Date(Date.now() + 864e5),
      serial: new X509Certificate(enrolled.cert).serialNumber,
    });
    await expect(
      client({ cert, key: request.key }).renewCertificate({ csrPem: request.csrPem }),
    ).rejects.toMatchObject({ code: Code.Unauthenticated });
  });

  it('requires a trusted server CA and matching hostname before enrollment', async () => {
    await expect(client(undefined, '', 'localhost').enroll({})).rejects.toBeDefined();
    await expect(client(undefined, caPem, 'rogue.example.com').enroll({})).rejects.toBeDefined();
  });

  it('bounds incoming messages and does not reflect malformed CSR contents', async () => {
    const token = await app.get(IssueJoinToken).execute({ organizationId: org, actor });
    await expect(
      client().enroll({ joinToken: token.value, csrPem: 'x'.repeat(70_000) }),
    ).rejects.toMatchObject({ code: Code.ResourceExhausted });
    await expect(
      client().enroll({ joinToken: token.value, csrPem: 'sensitive-invalid-csr' }),
    ).rejects.toMatchObject({
      code: Code.InvalidArgument,
      rawMessage: 'invalid certificate request',
    });
  });
});
