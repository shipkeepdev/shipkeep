import * as x509 from '@peculiar/x509';

import { EnrollNode } from '../modules/fleet/application/enroll-node';
import { IssueJoinToken } from '../modules/fleet/application/issue-join-token';
import { NodeLiveness } from '../modules/fleet/application/node-liveness';
import {
  generateEd25519KeyPair,
  importPrivateKey,
  importPublicKey,
  SIGNING_ALGORITHM,
} from '../modules/fleet/infrastructure/ca/x509';

import type { TenantHttpFixture } from './tenant-http';

/** A certificate signing request like the one an agent sends when it enrolls. */
export async function agentCsr(): Promise<string> {
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

/**
 * Enrolls a node in the fixture's organization the way an agent does (join token, CSR,
 * enrollment), then makes it ready with a first heartbeat. Returns its id. Integration tests
 * outside `fleet` use this instead of importing fleet's infrastructure (issue #295).
 *
 * A node is ready for 15 seconds after a heartbeat. A test that must not depend on how long its
 * setup takes passes `heartbeatAt` and gives the same time to the code under test as its clock.
 */
export async function enrollTestNode(
  fixture: Pick<TenantHttpFixture, 'app' | 'organizationId' | 'actors'>,
  node: {
    readonly facts: Readonly<Record<string, unknown>>;
    readonly name?: string;
    readonly heartbeatAt?: Date;
  },
): Promise<string> {
  const token = await fixture.app.get(IssueJoinToken).execute({
    organizationId: fixture.organizationId,
    actor: { kind: 'user', id: fixture.actors.owner.id },
  });
  const { nodeId } = await fixture.app.get(EnrollNode).execute({
    joinToken: token.value,
    csrPem: await agentCsr(),
    facts: node.facts,
    agentVersion: '0.1.0',
    ...(node.name === undefined ? {} : { name: node.name }),
  });
  await fixture.app
    .get(NodeLiveness)
    .heartbeat({ organizationId: fixture.organizationId, nodeId, serial: '' }, node.heartbeatAt);
  return nodeId;
}
