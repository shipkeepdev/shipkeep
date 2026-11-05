import * as x509 from '@peculiar/x509';
import { Secret } from '@shipkeep/domain';

import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { EnrollNode } from './application/enroll-node';
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
      'id',
      'token',
    ]);
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
  });
});
