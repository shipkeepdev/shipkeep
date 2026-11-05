import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import * as x509 from '@peculiar/x509';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../../platform/prisma/prisma.service';
import { auditLog } from '../../testing/audit-log';
import { applyMigrations } from '../../testing/apply-migrations';
import { fleetDatabase, type FleetDatabase } from '../../testing/fleet-database';
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
  let db: FleetDatabase;
  const previousUrl = process.env['DATABASE_URL'];
  const rows = async (sql: string, values: readonly unknown[]) =>
    (await db.admin.query<Record<string, unknown>>(sql, [...values])).rows;

  beforeAll(async () => {
    if (!previousUrl) container = await new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
    const adminUrl = container?.getConnectionUri() ?? previousUrl ?? '';
    // Shared CI database: start from an empty schema so this file's KEK matches every row.
    await resetDatabase(adminUrl);
    await applyMigrations(adminUrl, resolve(__dirname, '../../../prisma/migrations'));
    // The API runs on the restricted login, under the fleet row security (ADR 0015).
    db = await fleetDatabase(adminUrl);
    await db.createOrganization(org);
    process.env['DATABASE_URL'] = db.runtimeUrl;
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
    await db.close();
    await container?.stop();
    if (previousUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
    else process.env['DATABASE_URL'] = previousUrl;
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

    expect(
      await rows('SELECT organization_id,name,status,lease_epoch FROM nodes WHERE id=$1', [
        result.nodeId,
      ]),
    ).toEqual([{ organization_id: org, name: 'edge-1', status: 'enrolling', lease_epoch: 1 }]);
    expect(
      await rows('SELECT organization_id,revoked_at FROM node_certificates WHERE node_id=$1', [
        result.nodeId,
      ]),
    ).toEqual([{ organization_id: org, revoked_at: null }]);
    const stored = await rows('SELECT used_by_node_id,token_hash FROM join_tokens WHERE id=$1', [
      token.id,
    ]);
    expect(stored[0]?.['used_by_node_id']).toBe(result.nodeId);
    expect(stored[0]?.['token_hash']).not.toBe(token.value.expose());

    const keys = await prisma.installationKey.findMany();
    expect(keys.map((k) => k.kind).sort()).toEqual(['ca', 'confirmation']);
    for (const key of keys) {
      expect(Buffer.from(key.privateKeyEnc).toString('utf8')).not.toContain('PRIVATE KEY');
    }

    const audit = await auditLog().findMany({
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
    const certificates = await rows('SELECT serial FROM node_certificates WHERE node_id=$1', [
      result.nodeId,
    ]);
    return {
      organizationId: org,
      nodeId: result.nodeId,
      serial: String(certificates[0]?.['serial']),
    };
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
    const rows = await auditLog().findMany({
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
      await rows('SELECT id FROM node_certificates WHERE node_id=$1 AND revoked_at IS NULL', [
        identity.nodeId,
      ]),
    ).toHaveLength(1);
    expect(
      await auditLog().count({
        where: { targetId: identity.nodeId, action: 'fleet.node.certificate_renewed' },
      }),
    ).toBe(1);
  });

  it('leaves no join token behind when its issuance cannot be audited', async () => {
    if (!app) throw new Error('application did not start');
    const tokens = () => rows('SELECT id FROM join_tokens WHERE organization_id=$1', [org]);
    const before = (await tokens()).length;
    const unsubscribe = app
      .get(DomainEventBus)
      .subscribe(() => Promise.reject(new Error('injected failure')));
    try {
      // Tenant-scoped storage reports any non-domain failure as unavailable, without details.
      await expect(app.get(IssueJoinToken).execute({ organizationId: org, actor })).rejects.toThrow(
        'Tenant storage temporarily unavailable.',
      );
    } finally {
      unsubscribe();
    }
    expect(await tokens()).toHaveLength(before);
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
      await rows('SELECT id FROM node_certificates WHERE node_id=$1', [identity.nodeId]),
    ).toHaveLength(1);
    expect(
      await auditLog().count({
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
