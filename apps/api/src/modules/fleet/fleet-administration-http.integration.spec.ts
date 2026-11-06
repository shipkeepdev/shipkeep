import * as x509 from '@peculiar/x509';
import { Client } from 'pg';
import { Secret } from '@shipkeep/domain';

import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { EnrollNode } from './application/enroll-node';
import { NodeLiveness } from './application/node-liveness';
import {
  generateEd25519KeyPair,
  importPrivateKey,
  importPublicKey,
  SIGNING_ALGORITHM,
} from './infrastructure/ca/x509';

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

/** PLAN M2.7a: join token issuance and node listing over HTTP. */
describe('fleet administration over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  const resetLimits = () => fixture.prisma.identityThrottle.deleteMany();

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('issues a single-use join token to organization administrators after a fresh proof', async () => {
    const proof = { password: fixture.password.expose() };
    const issued = await fixture.post(`${fixture.root}/join-tokens`, 'admin', proof).expect(201);
    const body = issued.body as { id: string; token: string; caFingerprint: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.caFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.keys(issued.body as object).sort()).toEqual([
      'caFingerprint',
      'expiresAt',
      'gatewayAddress',
      'id',
      'token',
    ]);
    expect((issued.body as { gatewayAddress: string }).gatewayAddress).toMatch(/^[^\s:]+:\d+$/);
    const events = await auditLog().findMany({
      where: { action: 'fleet.join_token.issued', targetId: body.id },
    });
    expect(events.map((event) => [event.actorId, event.organizationId])).toEqual([
      [fixture.actors.admin.id, fixture.organizationId],
    ]);
    expect(JSON.stringify(events)).not.toContain(body.token);

    await resetLimits();
    await fixture
      .post(`${fixture.root}/join-tokens`, 'admin', { password: 'incorrect fixture password' })
      .expect(401);
    for (const actor of ['member', 'projectAdmin', 'outsider'] as const) {
      await resetLimits();
      await fixture.post(`${fixture.root}/join-tokens`, actor, proof).expect(404);
    }
    await resetLimits();
    await fixture.post(`${fixture.root}/join-tokens`, 'admin', {}).expect(400);
  });

  it('lists only the organization nodes, to its administrators', async () => {
    await resetLimits();
    const issued = await fixture
      .post(`${fixture.root}/join-tokens`, 'owner', { password: fixture.password.expose() })
      .expect(201);
    const enrolled = await fixture.app.get(EnrollNode).execute({
      joinToken: new Secret((issued.body as { token: string }).token),
      csrPem: await agentCsr(),
      facts: { hostname: 'edge-http.example.com' },
      agentVersion: '0.1.0',
    });
    const page = await fixture.get(`${fixture.root}/nodes`, 'admin').expect(200);
    expect((page.body as { items: { id: string; name: string }[] }).items).toEqual([
      expect.objectContaining({ id: enrolled.nodeId, name: 'edge-http', status: 'enrolling' }),
    ]);
    expect(JSON.stringify(page.body)).not.toMatch(/certificate|token_hash|tokenHash/);
    for (const actor of ['member', 'projectAdmin', 'outsider'] as const)
      await fixture.get(`${fixture.root}/nodes`, actor).expect(404);
    // The fixture owner also owns the foreign organization, which has no node.
    const foreign = await fixture
      .get(`/api/v1/organizations/${fixture.foreignId}/nodes`, 'owner')
      .expect(200);
    expect(foreign.body).toEqual({ items: [], nextCursor: null });

    // A connected agent's heartbeat makes the node ready, audited once (M3.4c1).
    const identity = {
      organizationId: fixture.organizationId,
      nodeId: enrolled.nodeId,
      serial: '',
    };
    await fixture.app.get(NodeLiveness).heartbeat(identity);
    await fixture.app.get(NodeLiveness).heartbeat(identity);
    const ready = await fixture.get(`${fixture.root}/nodes`, 'admin').expect(200);
    expect((ready.body as { items: { status: string }[] }).items[0]?.status).toBe('ready');
    const events = await auditLog().findMany({
      where: { action: 'fleet.node.ready', targetId: enrolled.nodeId },
    });
    expect(events.map((event) => event.metadata)).toEqual([{ from: 'enrolling' }]);
  });

  it('removes a node only with a confirmation for that node, revoking its certificates', async () => {
    const enroll = async (hostname: string) => {
      await resetLimits();
      const issued = await fixture
        .post(`${fixture.root}/join-tokens`, 'owner', { password: fixture.password.expose() })
        .expect(201);
      return fixture.app.get(EnrollNode).execute({
        joinToken: new Secret((issued.body as { token: string }).token),
        csrPem: await agentCsr(),
        facts: { hostname },
        agentVersion: '0.1.0',
      });
    };
    const target = await enroll('edge-remove.example.com');
    const sibling = await enroll('edge-keep.example.com');
    const confirm = async (nodeId: string, name: string) =>
      (
        (
          await fixture
            .post(`${fixture.root}/confirmations`, 'admin', {
              action: 'node.remove',
              target: nodeId,
              name,
            })
            .expect(201)
        ).body as { token: string }
      ).token;
    const remove = (nodeId: string, body: object, actor: 'admin' | 'member' = 'admin') =>
      fixture.post(`${fixture.root}/nodes/${nodeId}/remove`, actor, body);

    await remove(target.nodeId, {}).expect(400);
    const forSibling = await confirm(sibling.nodeId, 'edge-keep');
    await remove(target.nodeId, { confirmation: forSibling })
      .expect(400)
      .expect((response) => {
        expect(response.body).toMatchObject({ code: 'confirmation_rejected' });
      });
    const token = await confirm(target.nodeId, 'edge-remove');
    await remove(target.nodeId, { confirmation: token }, 'member').expect(404);
    await remove(target.nodeId, { confirmation: token }).expect(204);
    await remove(target.nodeId, { confirmation: token }).expect(404);

    const admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    try {
      const nodes = await admin.query<{ id: string; status: string }>(
        'SELECT id,status FROM nodes WHERE id = ANY($1)',
        [[target.nodeId, sibling.nodeId]],
      );
      expect(nodes.rows.find((row) => row.id === target.nodeId)?.status).toBe('removed');
      expect(nodes.rows.find((row) => row.id === sibling.nodeId)?.status).not.toBe('removed');
      const live = await admin.query(
        'SELECT id FROM node_certificates WHERE node_id=$1 AND revoked_at IS NULL',
        [target.nodeId],
      );
      expect(live.rowCount).toBe(0);
    } finally {
      await admin.end();
    }
    const events = await auditLog().findMany({
      where: { action: 'fleet.node.removed', targetId: target.nodeId },
    });
    expect(events.map((event) => event.actorId)).toEqual([fixture.actors.admin.id]);
  });
});
