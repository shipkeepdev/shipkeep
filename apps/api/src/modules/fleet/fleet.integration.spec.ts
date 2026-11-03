import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import * as x509 from '@peculiar/x509';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { applyMigrations } from '../../testing/apply-migrations';

import { EnrollNode } from './application/enroll-node';
import { IssueJoinToken } from './application/issue-join-token';
import { JoinTokenRejectedError } from './domain/join-token';
import {
  generateEd25519KeyPair,
  importPrivateKey,
  importPublicKey,
  SIGNING_ALGORITHM,
} from './infrastructure/ca/x509';

// Distinct from the organization used by the audit integration test: the database may be shared.
const org = '0192f0c0-0000-7000-8000-0000000000ab';
const actor = { kind: 'user' as const, id: 'usr_1', ip: '203.0.113.5' };

async function agentCsr(): Promise<string> {
  const pair = await generateEd25519KeyPair();
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=agent',
    keys: {
      publicKey: await importPublicKey(pair.publicKeyPem),
      privateKey: await importPrivateKey(pair.privateKeyPem),
    },
    signingAlgorithm: SIGNING_ALGORITHM,
  });
  return csr.toString('pem');
}

// Enrollment through the real stores, CA and audit log (PLAN M1.2a acceptance).
describe('fleet enrollment against PostgreSQL', () => {
  let app: INestApplication | undefined;
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    if (!process.env['DATABASE_URL']) {
      container = await new PostgreSqlContainer('postgres:17').start();
      process.env['DATABASE_URL'] = container.getConnectionUri();
    }
    await applyMigrations(
      process.env['DATABASE_URL'],
      resolve(__dirname, '../../../prisma/migrations'),
    );
    const kekPath = join(await mkdtemp(join(tmpdir(), 'shipkeep-fleet-')), 'kek');
    await writeFile(kekPath, randomBytes(32), { mode: 0o400 });
    process.env['SHIPKEEP_KEK_FILE'] = kekPath;
    process.env['LOG_LEVEL'] = 'error';
    const bootstrap = await import('../../bootstrap.js');
    const created = await bootstrap.createApp();
    await created.init();
    app = created;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('enrolls a node with a single-use token and a CA-signed certificate', async () => {
    if (!app) throw new Error('application did not start');
    const prisma = app.get(PrismaService);
    const token = await app.get(IssueJoinToken).execute({ organizationId: org, actor });
    expect(token.caFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    const result = await app.get(EnrollNode).execute({
      joinToken: token.value,
      csrPem: await agentCsr(),
      facts: { hostname: 'edge-1.example.com', cpu_count: 2 },
      agentVersion: '0.1.0',
      ip: '198.51.100.7',
    });

    const cert = new X509Certificate(result.certificatePem);
    const ca = new X509Certificate(result.caPem);
    expect(cert.checkIssued(ca)).toBe(true);
    expect(cert.subjectAltName).toBe(`URI:spiffe://shipkeep/${org}/node/${result.nodeId}`);
    expect(result.confirmationPublicKeyPem).toContain('BEGIN PUBLIC KEY');

    const node = await prisma.node.findUniqueOrThrow({ where: { id: result.nodeId } });
    expect(node).toMatchObject({
      organizationId: org,
      name: 'edge-1',
      status: 'enrolling',
      leaseEpoch: 1,
    });
    const certs = await prisma.nodeCertificate.findMany({ where: { nodeId: result.nodeId } });
    expect(certs).toHaveLength(1);
    expect(certs[0]?.revokedAt).toBeNull();
    const stored = await prisma.joinToken.findUniqueOrThrow({ where: { id: token.id } });
    expect(stored.usedByNodeId).toBe(result.nodeId);
    expect(stored.tokenHash).not.toBe(token.value);

    const keys = await prisma.installationKey.findMany();
    expect(keys.map((k) => k.kind).sort()).toEqual(['ca', 'confirmation']);
    for (const key of keys) {
      expect(Buffer.from(key.privateKeyEnc).toString('utf8')).not.toContain('PRIVATE KEY');
    }

    const audit = await prisma.auditEvent.findMany({
      where: { organizationId: org },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual(['fleet.join_token.issued', 'fleet.node.enrolled']);
    expect(JSON.stringify(audit)).not.toContain(token.value);

    // The token is spent: a second node cannot use it.
    await expect(
      app.get(EnrollNode).execute({
        joinToken: token.value,
        csrPem: await agentCsr(),
        facts: {},
        agentVersion: '0.1.0',
      }),
    ).rejects.toThrow(JoinTokenRejectedError);
  });
});
