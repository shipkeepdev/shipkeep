import * as x509 from '@peculiar/x509';
import { Secret } from '@shipkeep/domain';

import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';
import { EnrollNode } from '../fleet/application/enroll-node';
import { IssueJoinToken } from '../fleet/application/issue-join-token';
import {
  generateEd25519KeyPair,
  importPrivateKey,
  importPublicKey,
  SIGNING_ALGORITHM,
} from '../fleet/infrastructure/ca/x509';

import { ConfirmationVerifier } from './application/confirmation-verifier';
import { parseConfirmationToken } from './domain/confirmation-token';

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

/** PLAN M2.5a2: confirmation issuance over HTTP for `node.remove`. */
describe('confirmations over HTTP', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let nodeId: string;
  const path = () => `${fixture.root}/confirmations`;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    const token = await fixture.app.get(IssueJoinToken).execute({
      organizationId: fixture.organizationId,
      actor: { kind: 'user', id: fixture.actors.owner.id },
    });
    nodeId = (
      await fixture.app.get(EnrollNode).execute({
        joinToken: token.value,
        csrPem: await agentCsr(),
        facts: { hostname: 'edge-confirm.example.com' },
        agentVersion: '0.1.0',
      })
    ).nodeId;
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('issues a single-use token for the exact node name to organization administrators', async () => {
    const response = await fixture
      .post(path(), 'admin', { action: 'node.remove', target: nodeId, name: 'edge-confirm' })
      .expect(201);
    const body = response.body as { id: string; token: string; expiresAt: string };
    const parsed = parseConfirmationToken(body.token);
    expect(parsed?.claims).toMatchObject({
      jti: body.id,
      org: fixture.organizationId,
      action: 'node.remove',
      target: nodeId,
      sub: fixture.actors.admin.id,
    });
    const events = await auditLog().findMany({
      where: { action: 'confirmation.issued', targetId: body.id },
    });
    expect(events.map((event) => event.actorId)).toEqual([fixture.actors.admin.id]);
    expect(JSON.stringify(events)).not.toContain(body.token);

    const request = {
      organizationId: fixture.organizationId,
      action: 'node.remove' as const,
      target: nodeId,
    };
    const consume = () =>
      fixture.app
        .get(PrismaUnitOfWork)
        .runTenant(fixture.organizationId, () =>
          fixture.app
            .get(ConfirmationVerifier)
            .consume(new Secret(body.token), request, fixture.actors.admin.id),
        );
    await expect(consume()).resolves.toBe(body.id);
    await expect(consume()).rejects.toMatchObject({ code: 'confirmation_rejected' });
  });

  it('refuses wrong names, unknown targets and actions, and members without node.manage', async () => {
    const mismatch = await fixture
      .post(path(), 'owner', { action: 'node.remove', target: nodeId, name: 'edge-confirm ' })
      .expect(400);
    expect(mismatch.body).toMatchObject({ code: 'confirmation_name_mismatch' });
    await fixture
      .post(path(), 'owner', {
        action: 'node.remove',
        target: fixture.projectId,
        name: 'edge-confirm',
      })
      .expect(404);
    for (const body of [
      { action: 'organization.delete', target: nodeId, name: 'edge-confirm' },
      { action: 'node.remove', target: '../etc/passwd\n', name: 'edge-confirm' },
      { action: 'node.remove', target: nodeId, name: '' },
      { action: 'node.remove', target: nodeId },
    ])
      await fixture.post(path(), 'owner', body).expect(400);
    for (const actor of ['member', 'projectAdmin'] as const)
      await fixture
        .post(path(), actor, { action: 'node.remove', target: nodeId, name: 'edge-confirm' })
        .expect(404);
    await fixture
      .post(path(), 'outsider', { action: 'node.remove', target: nodeId, name: 'edge-confirm' })
      .expect(404);
  });
});
