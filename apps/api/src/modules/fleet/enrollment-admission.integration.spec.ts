import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Code, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import type { INestApplication } from '@nestjs/common';
import * as x509 from '@peculiar/x509';
import { AgentGatewayService } from '@shipkeep/proto-ts';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { applyMigrations } from '../../testing/apply-migrations';
import { fleetDatabase, type FleetDatabase } from '../../testing/fleet-database';
import { POSTGRES_TEST_IMAGE } from '../../testing/postgres-image';
import { resetDatabase } from '../../testing/reset-database';

import { IssueJoinToken } from './application/issue-join-token';
import { JOIN_TOKEN_STORE, type JoinTokenStore } from './application/ports';
import {
  generateEd25519KeyPair,
  importPrivateKey,
  importPublicKey,
  SIGNING_ALGORITHM,
} from './infrastructure/ca/x509';
import { X509CertificateAuthority } from './infrastructure/ca/x509-certificate-authority';
import { AgentGateway } from './interface/agent-gateway';
import { ENROLLMENT_LIMITS, EnrollmentAdmission } from './interface/enrollment-admission';

const org = '0192f0c0-0000-7000-8000-0000000000ad';
const actor = { kind: 'user' as const, id: 'usr_test' };
/** Enrollment attempts this network may make in the test's minute. */
const QUOTA = 6;

async function requestCertificate() {
  const keys = await generateEd25519KeyPair();
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=admission',
    signingAlgorithm: SIGNING_ALGORITHM,
    keys: {
      publicKey: await importPublicKey(keys.publicKeyPem),
      privateKey: await importPrivateKey(keys.privateKeyPem),
    },
  });
  return { key: keys.privateKeyPem, csrPem: csr.toString('pem') };
}

async function* hello(nodeId: string, leaseEpoch: bigint) {
  yield await Promise.resolve({
    msg: { case: 'hello' as const, value: { nodeId, leaseEpoch } },
  });
}

/** Enrollment admission over real HTTP/2 connections, before any database work (#346). */
describe('enrollment admission over real HTTP/2 TLS and PostgreSQL', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer | undefined;
  let db: FleetDatabase;
  let caPem: string;
  let baseUrl: string;
  let lookups: number;
  const previous = {
    url: process.env['DATABASE_URL'],
    quota: process.env['AGENT_ENROLLMENTS_PER_MINUTE'],
  };

  /** A client on its own HTTP/2 connection. */
  function client(credentials?: { cert: string; key: string }) {
    return createClient(
      AgentGatewayService,
      createGrpcTransport({
        baseUrl,
        nodeOptions: { ca: caPem, servername: 'localhost', ...credentials },
        defaultTimeoutMs: 5000,
        idleConnectionTimeoutMs: 100,
      }),
    );
  }

  const issue = () => app.get(IssueJoinToken).execute({ organizationId: org, actor });
  const unused = async (tokenId: string) =>
    (
      await db.admin.query<{ used_at: Date | null }>(
        'SELECT used_at FROM join_tokens WHERE id = $1',
        [tokenId],
      )
    ).rows[0]?.used_at === null;
  const nodes = async () =>
    Number(
      (await db.admin.query<{ n: string }>('SELECT count(*) AS n FROM nodes')).rows[0]?.n ?? 0,
    );

  beforeAll(async () => {
    if (!previous.url) container = await new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
    const adminUrl = container?.getConnectionUri() ?? previous.url ?? '';
    await resetDatabase(adminUrl);
    await applyMigrations(adminUrl, resolve(__dirname, '../../../prisma/migrations'));
    db = await fleetDatabase(adminUrl);
    await db.createOrganization(org);
    process.env['DATABASE_URL'] = db.runtimeUrl;
    process.env['AGENT_ENROLLMENTS_PER_MINUTE'] = String(QUOTA);
    const path = join(await mkdtemp(join(tmpdir(), 'shipkeep-admission-')), 'kek');
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
    // Counts the token lookups: a refused enrollment must not reach the store.
    const store = app.get<JoinTokenStore>(JOIN_TOKEN_STORE);
    const find = store.findByHash.bind(store);
    lookups = 0;
    store.findByHash = (hash) => {
      lookups++;
      return find(hash);
    };
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    await container?.stop();
    for (const [name, value] of [
      ['DATABASE_URL', previous.url],
      ['AGENT_ENROLLMENTS_PER_MINUTE', previous.quota],
    ] as const)
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
  });

  // The two cases share the network's quota, in this order: six attempts in all.
  let enrolled: { nodeId: string; leaseEpoch: bigint; cert: string; key: string };
  /** The first frame the gateway sends the enrolled node on a new stream. */
  const welcome = () => {
    const stream = client({ cert: enrolled.cert, key: enrolled.key }).connect(
      hello(enrolled.nodeId, enrolled.leaseEpoch),
    );
    return stream[Symbol.asyncIterator]().next();
  };

  it('refuses enrollment once the global budget is full, whatever the connection, and keeps nodes connected', async () => {
    // Attempt 1: a node enrolls.
    const first = await requestCertificate();
    const result = await client().enroll({
      joinToken: (await issue()).value.expose(),
      csrPem: first.csrPem,
      facts: { hostname: 'admission-first' },
      agentVersion: '0.1.0',
    });
    enrolled = {
      nodeId: result.nodeId,
      leaseEpoch: result.leaseEpoch,
      cert: result.certPem,
      key: first.key,
    };
    // Every slot taken and every queue place held, as by enrollments on other connections.
    const admission = app.get(EnrollmentAdmission);
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const holders = Array.from(
      { length: ENROLLMENT_LIMITS.concurrent + ENROLLMENT_LIMITS.queued },
      () => admission.run(() => held),
    );
    expect(admission.load()).toEqual({
      running: ENROLLMENT_LIMITS.concurrent,
      waiting: ENROLLMENT_LIMITS.queued,
    });
    // Attempt 2, on a new connection: refused at once, before the store.
    const token = await issue();
    const before = { lookups, nodes: await nodes() };
    await expect(
      client().enroll({
        joinToken: token.value.expose(),
        csrPem: (await requestCertificate()).csrPem,
        facts: { hostname: 'admission-refused' },
        agentVersion: '0.1.0',
      }),
    ).rejects.toMatchObject({ code: Code.ResourceExhausted });
    expect({ lookups, nodes: await nodes() }).toEqual(before);
    expect(await unused(token.id)).toBe(true);
    // An enrolled node keeps its stream meanwhile.
    await expect(welcome()).resolves.toMatchObject({ value: { msg: { case: 'welcome' } } });
    open();
    await Promise.all(holders);
    // Attempt 3: the same token enrolls once the budget is free.
    await expect(
      client().enroll({
        joinToken: token.value.expose(),
        csrPem: (await requestCertificate()).csrPem,
        facts: { hostname: 'admission-later' },
        agentVersion: '0.1.0',
      }),
    ).resolves.toHaveProperty('nodeId');
    expect(admission.load()).toEqual({ running: 0, waiting: 0 });
  });

  it('counts every connection of a network against its quota, and answers without token state', async () => {
    // Attempts 4 to 6, each on its own connection: malformed, refused without a lookup.
    const before = lookups;
    for (const joinToken of ['not a token', "skj_' OR 1=1 --", 'x'.repeat(60_000)])
      await expect(
        client().enroll({ joinToken, csrPem: 'x', facts: {}, agentVersion: '0.1.0' }),
      ).rejects.not.toMatchObject({ code: Code.ResourceExhausted });
    expect(lookups).toBe(before);
    // Attempt 7, with a valid token on a new connection: over the quota.
    const token = await issue();
    const error: unknown = await client()
      .enroll({
        joinToken: token.value.expose(),
        csrPem: (await requestCertificate()).csrPem,
        facts: { hostname: 'admission-over' },
        agentVersion: '0.1.0',
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: Code.ResourceExhausted });
    // The answer says nothing about the token, and the token stays usable.
    expect(JSON.stringify(error)).not.toContain(token.value.expose());
    expect((error as { rawMessage: string }).rawMessage).toBe('enrollment is busy, retry later');
    expect(lookups).toBe(before);
    expect(await unused(token.id)).toBe(true);
    // Enrolled nodes are not enrollments: their streams do not count.
    await expect(welcome()).resolves.toMatchObject({ value: { msg: { case: 'welcome' } } });
  });
});
