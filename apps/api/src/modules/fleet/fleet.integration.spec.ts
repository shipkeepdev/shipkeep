import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import * as x509 from '@peculiar/x509';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { applyMigrations } from '../../testing/apply-migrations';
import { resetDatabase } from '../../testing/reset-database';

import { EnrollNode } from './application/enroll-node';
import { AuthenticateNode } from './application/authenticate-node';
import { IssueJoinToken } from './application/issue-join-token';
import { RenewNodeCertificate } from './application/renew-node-certificate';
import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { JoinTokenRejectedError } from './domain/join-token';
import {
  generateEd25519KeyPair,
  importPrivateKey,
  importPublicKey,
  SIGNING_ALGORITHM,
} from './infrastructure/ca/x509';
import { POSTGRES_TEST_IMAGE } from '../../testing/postgres-image';

// Distinct from the organization used by the audit integration test: the database may be shared.
const org = '0192f0c0-0000-7000-8000-0000000000ab';
const owner = '0192f0c0-0000-7000-8000-0000000000ac';
const actor = { kind: 'user' as const, id: owner, ip: '203.0.113.5' };

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
      container = await new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
      process.env['DATABASE_URL'] = container.getConnectionUri();
    }
    // Shared CI database: start from an empty schema so this file's KEK matches every row.
    await resetDatabase(process.env['DATABASE_URL']);
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
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.org_id', ${org}, true)`;
      await tx.user.create({
        data: {
          id: owner,
          email: 'fleet-owner@example.com',
          passwordHash: 'fixture-hash',
          status: 'active',
          emailVerifiedAt: new Date(),
        },
      });
      await tx.organization.create({
        data: { id: org, name: 'Fleet fixture', slug: 'fleet-fixture' },
      });
      await tx.membership.create({
        data: {
          id: '0192f0c0-0000-7000-8000-0000000000ad',
          organizationId: org,
          userId: owner,
          orgRole: 'owner',
        },
      });
    });
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
    expect(stored.tokenHash).not.toBe(token.value.expose());

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
    expect(JSON.stringify(audit)).not.toContain(token.value.expose());

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

  async function enrolled(name: string) {
    if (!app) throw new Error('application did not start');
    const token = await app.get(IssueJoinToken).execute({ organizationId: org, actor });
    const result = await app.get(EnrollNode).execute({
      joinToken: token.value,
      csrPem: await agentCsr(),
      facts: {},
      agentVersion: '0.1.0',
      name,
    });
    const cert = await app
      .get(PrismaService)
      .nodeCertificate.findFirstOrThrow({ where: { nodeId: result.nodeId } });
    return { organizationId: org, nodeId: result.nodeId, serial: cert.serial };
  }

  it('renews with the authenticated identity, revokes the previous certificate and audits once', async () => {
    if (!app) throw new Error('application did not start');
    const identity = await enrolled('renewal');
    const renewed = await app.get(RenewNodeCertificate).execute(identity, await agentCsr());
    const cert = new X509Certificate(renewed.certificatePem);
    expect(cert.subjectAltName).toBe(`URI:spiffe://shipkeep/${org}/node/${identity.nodeId}`);
    await expect(app.get(AuthenticateNode).execute(identity)).rejects.toMatchObject({
      code: 'node_unauthenticated',
    });
    await expect(
      app.get(AuthenticateNode).execute({ ...identity, serial: renewed.serial }),
    ).resolves.toMatchObject({ nodeId: identity.nodeId });
    const rows = await app.get(PrismaService).auditEvent.findMany({
      where: { targetId: identity.nodeId, action: 'fleet.node.certificate_renewed' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({
      previousSerial: identity.serial,
      certificateSerial: renewed.serial,
    });
  });

  it('allows only one concurrent renewal of a certificate', async () => {
    if (!app) throw new Error('application did not start');
    const identity = await enrolled('concurrent-renewal');
    const csr = await agentCsr();
    const renew = app.get(RenewNodeCertificate);
    const results = await Promise.allSettled([
      renew.execute(identity, csr),
      renew.execute(identity, csr),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      await app
        .get(PrismaService)
        .nodeCertificate.count({ where: { nodeId: identity.nodeId, revokedAt: null } }),
    ).toBe(1);
    expect(
      await app.get(PrismaService).auditEvent.count({
        where: { targetId: identity.nodeId, action: 'fleet.node.certificate_renewed' },
      }),
    ).toBe(1);
  });

  it('leaves no join token behind when its issuance cannot be audited', async () => {
    if (!app) throw new Error('application did not start');
    const prisma = app.get(PrismaService);
    const before = await prisma.joinToken.count({ where: { organizationId: org } });
    const unsubscribe = app
      .get(DomainEventBus)
      .subscribe(() => Promise.reject(new Error('injected failure')));
    try {
      await expect(app.get(IssueJoinToken).execute({ organizationId: org, actor })).rejects.toThrow(
        'injected failure',
      );
    } finally {
      unsubscribe();
    }
    expect(await prisma.joinToken.count({ where: { organizationId: org } })).toBe(before);
  });

  it('rolls back the new certificate, revocation and audit if an event subscriber fails', async () => {
    if (!app) throw new Error('application did not start');
    const identity = await enrolled('failed-renewal');
    const unsubscribe = app
      .get(DomainEventBus)
      .subscribe(() => Promise.reject(new Error('injected failure')));
    try {
      await expect(
        app.get(RenewNodeCertificate).execute(identity, await agentCsr()),
      ).rejects.toThrow('injected failure');
    } finally {
      unsubscribe();
    }
    await expect(app.get(AuthenticateNode).execute(identity)).resolves.toMatchObject({
      nodeId: identity.nodeId,
    });
    expect(
      await app.get(PrismaService).nodeCertificate.count({ where: { nodeId: identity.nodeId } }),
    ).toBe(1);
    expect(
      await app.get(PrismaService).auditEvent.count({
        where: { targetId: identity.nodeId, action: 'fleet.node.certificate_renewed' },
      }),
    ).toBe(0);
  });

  it('rejects cross-organization identities and invalid CSRs without revoking the current certificate', async () => {
    if (!app) throw new Error('application did not start');
    const identity = await enrolled('invalid-renewal');
    const renew = app.get(RenewNodeCertificate);
    await expect(
      renew.execute(
        { ...identity, organizationId: '0192f0c0-0000-7000-8000-0000000000ff' },
        await agentCsr(),
      ),
    ).rejects.toMatchObject({ code: 'node_unauthenticated' });
    await expect(renew.execute(identity, 'x'.repeat(8193))).rejects.toMatchObject({
      code: 'csr_too_large',
    });
    await expect(renew.execute(identity, 'not a CSR')).rejects.toThrow(
      'certificate request rejected',
    );
    await expect(app.get(AuthenticateNode).execute(identity)).resolves.toMatchObject({
      nodeId: identity.nodeId,
    });
  });
});
