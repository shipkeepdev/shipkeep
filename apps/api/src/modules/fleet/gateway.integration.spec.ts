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

import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { applyMigrations } from '../../testing/apply-migrations';
import { fleetDatabase, type FleetDatabase } from '../../testing/fleet-database';
import { POSTGRES_TEST_IMAGE } from '../../testing/postgres-image';
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
  let db: FleetDatabase;
  let caPem: string;
  let baseUrl: string;
  const previousUrl = process.env['DATABASE_URL'];
  const rows = async (sql: string, values: readonly unknown[]) =>
    (await db.admin.query<Record<string, unknown>>(sql, [...values])).rows;
  const revoke = (nodeId: string) =>
    db.admin.query('UPDATE node_certificates SET revoked_at=now() WHERE node_id=$1', [nodeId]);

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
      joinToken: token.value.expose(),
      csrPem: request.csrPem,
      facts: { hostname: name },
      agentVersion: '0.1.0',
    });
    return { token, result, key: request.key, cert: result.certPem };
  }

  beforeAll(async () => {
    if (!previousUrl) container = await new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
    const adminUrl = container?.getConnectionUri() ?? previousUrl ?? '';
    await resetDatabase(adminUrl);
    await applyMigrations(adminUrl, resolve(__dirname, '../../../prisma/migrations'));
    // The gateway runs on the restricted login, under the fleet row security (ADR 0015).
    db = await fleetDatabase(adminUrl);
    await db.createOrganization(org);
    process.env['DATABASE_URL'] = db.runtimeUrl;
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
    await db.close();
    await container?.stop();
    if (previousUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env['DATABASE_URL'] = previousUrl;
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
        joinToken: enrolled.token.value.expose(),
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

  it('consumes a join token once under concurrency without leaving orphaned nodes', async () => {
    const token = await app.get(IssueJoinToken).execute({ organizationId: org, actor });
    const request = await requestCertificate();
    const results = await Promise.allSettled(
      ['tls-race-a', 'tls-race-b'].map((hostname) =>
        client().enroll({
          joinToken: token.value.expose(),
          csrPem: request.csrPem,
          facts: { hostname },
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      await rows(
        'SELECT n.id, count(c.id)::int AS certificates FROM nodes n LEFT JOIN node_certificates c ON c.node_id=n.id WHERE n.name = ANY($1) GROUP BY n.id',
        [['tls-race-a', 'tls-race-b']],
      ),
    ).toMatchObject([{ certificates: 1 }]);
  });

  it('rolls back enrollment and preserves the join token if audit delivery fails', async () => {
    const token = await app.get(IssueJoinToken).execute({ organizationId: org, actor });
    const request = await requestCertificate();
    const unsubscribe = app
      .get(DomainEventBus)
      .subscribe(() => Promise.reject(new Error('injected audit failure')));
    try {
      await expect(
        client().enroll({
          joinToken: token.value.expose(),
          csrPem: request.csrPem,
          facts: { hostname: 'tls-audit-failure' },
        }),
      ).rejects.toMatchObject({ code: Code.Internal });
    } finally {
      unsubscribe();
    }
    expect(await rows('SELECT id FROM nodes WHERE name=$1', ['tls-audit-failure'])).toHaveLength(0);
    expect(await rows('SELECT used_at FROM join_tokens WHERE id=$1', [token.id])).toEqual([
      { used_at: null },
    ]);
    await expect(
      client().enroll({
        joinToken: token.value.expose(),
        csrPem: request.csrPem,
        facts: { hostname: 'tls-audit-failure' },
      }),
    ).resolves.toHaveProperty('nodeId');
  });

  it('authenticates streaming methods and accepts a matching Hello', async () => {
    const enrolled = await enroll('tls-stream-auth');
    const input = [
      {
        msg: {
          case: 'hello' as const,
          value: { nodeId: enrolled.result.nodeId, leaseEpoch: enrolled.result.leaseEpoch },
        },
      },
    ];
    await expect(
      client().connect(messages(input))[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    await expect(
      client(enrolled).connect(messages(input))[Symbol.asyncIterator]().next(),
    ).resolves.toMatchObject({ value: { msg: { case: 'welcome' } } });
    await expect(
      client().execStream(messages([]))[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
  });

  it('rejects forged Hello identities, stale epochs and out-of-order frames', async () => {
    const enrolled = await enroll('tls-stream-validation');
    const current = client(enrolled);
    for (const value of [
      { nodeId: 'forged', leaseEpoch: enrolled.result.leaseEpoch },
      { nodeId: enrolled.result.nodeId, leaseEpoch: enrolled.result.leaseEpoch + 1n },
    ]) {
      await expect(
        current
          .connect(messages([{ msg: { case: 'hello', value } }]))
          [Symbol.asyncIterator]()
          .next(),
      ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    }
    await expect(
      current
        .connect(messages([{ msg: { case: 'heartbeat', value: {} } }]))
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    const hello = {
      msg: {
        case: 'hello' as const,
        value: { nodeId: enrolled.result.nodeId, leaseEpoch: enrolled.result.leaseEpoch },
      },
    };
    const repeated = current.connect(messages([hello, hello]))[Symbol.asyncIterator]();
    await expect(repeated.next()).resolves.toMatchObject({ value: { msg: { case: 'welcome' } } });
    await expect(repeated.next()).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  it('disconnects a silent stream promptly after certificate revocation', async () => {
    const enrolled = await enroll('tls-live-revocation');
    const abort = new AbortController();
    async function* input() {
      yield {
        msg: {
          case: 'hello' as const,
          value: { nodeId: enrolled.result.nodeId, leaseEpoch: enrolled.result.leaseEpoch },
        },
      };
      await new Promise<void>((resolve) => {
        if (abort.signal.aborted) resolve();
        else
          abort.signal.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
      });
    }
    try {
      const stream = client(enrolled)
        .connect(input(), { signal: abort.signal })
        [Symbol.asyncIterator]();
      await expect(stream.next()).resolves.toMatchObject({ value: { msg: { case: 'welcome' } } });
      const closed = stream.next();
      await revoke(enrolled.result.nodeId);
      await expect(closed).rejects.toMatchObject({ code: Code.Unauthenticated });
    } finally {
      abort.abort();
    }
  });

  it('accepts streaming deadlines above the unary limit and replaces duplicate connections', async () => {
    const enrolled = await enroll('tls-stream-replacement');
    const abort = new AbortController();
    async function* input() {
      yield {
        msg: {
          case: 'hello' as const,
          value: { nodeId: enrolled.result.nodeId, leaseEpoch: enrolled.result.leaseEpoch },
        },
      };
      await new Promise<void>((resolve) => {
        if (abort.signal.aborted) resolve();
        else
          abort.signal.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true },
          );
      });
    }
    try {
      const first = client(enrolled)
        .connect(input(), { signal: abort.signal, timeoutMs: 60_000 })
        [Symbol.asyncIterator]();
      await expect(first.next()).resolves.toMatchObject({ value: { msg: { case: 'welcome' } } });
      const closed = expect(first.next()).rejects.toMatchObject({ code: Code.Aborted });
      const second = client(enrolled)
        .connect(input(), { signal: abort.signal })
        [Symbol.asyncIterator]();
      await expect(second.next()).resolves.toMatchObject({ value: { msg: { case: 'welcome' } } });
      await closed;
    } finally {
      abort.abort();
    }
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
    await revoke(enrolled.result.nodeId);
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
      client().enroll({ joinToken: token.value.expose(), csrPem: 'x'.repeat(70_000) }),
    ).rejects.toMatchObject({ code: Code.ResourceExhausted });
    await expect(
      client().enroll({ joinToken: token.value.expose(), csrPem: 'sensitive-invalid-csr' }),
    ).rejects.toMatchObject({
      code: Code.InvalidArgument,
      rawMessage: 'invalid certificate request',
    });
  });
});
