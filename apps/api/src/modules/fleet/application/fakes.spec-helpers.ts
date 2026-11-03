// In-memory implementations of the fleet ports for unit tests.
import type { JoinTokenRecord } from '../domain/join-token';
import type { NodeCertificateRecord, NodeRecord } from '../domain/node';

import type {
  CertificateAuthority,
  ConfirmationKeyProvider,
  IssuedCertificate,
  JoinTokenStore,
  NodeStore,
} from './ports';

export class MemoryJoinTokenStore implements JoinTokenStore {
  readonly records = new Map<string, JoinTokenRecord>();
  insert(record: JoinTokenRecord): Promise<void> {
    this.records.set(record.id, record);
    return Promise.resolve();
  }
  findByHash(tokenHash: string): Promise<JoinTokenRecord | undefined> {
    return Promise.resolve([...this.records.values()].find((r) => r.tokenHash === tokenHash));
  }
  consume(id: string, nodeId: string, usedAt: Date): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.usedAt !== null) return Promise.resolve(false);
    this.records.set(id, { ...record, usedAt, usedByNodeId: nodeId });
    return Promise.resolve(true);
  }
}

export class MemoryNodeStore implements NodeStore {
  readonly nodes: NodeRecord[] = [];
  readonly certificates: NodeCertificateRecord[] = [];
  insert(node: NodeRecord): Promise<void> {
    this.nodes.push(node);
    return Promise.resolve();
  }
  findByName(organizationId: string, name: string): Promise<NodeRecord | undefined> {
    return Promise.resolve(
      this.nodes.find((n) => n.organizationId === organizationId && n.name === name),
    );
  }
  insertCertificate(certificate: NodeCertificateRecord): Promise<void> {
    this.certificates.push(certificate);
    return Promise.resolve();
  }
}

export class FakeCertificateAuthority implements CertificateAuthority {
  issued: { csrPem: string; organizationId: string; nodeId: string }[] = [];
  private serial = 0;
  caCertificatePem(): Promise<string> {
    return Promise.resolve('-----BEGIN CERTIFICATE-----\nFAKECA\n-----END CERTIFICATE-----\n');
  }
  caFingerprint(): Promise<string> {
    return Promise.resolve(`sha256:${'ab'.repeat(32)}`);
  }
  issueNodeCertificate(
    csrPem: string,
    identity: { organizationId: string; nodeId: string },
  ): Promise<IssuedCertificate> {
    if (!csrPem.includes('BEGIN CERTIFICATE REQUEST')) return Promise.reject(new Error('bad csr'));
    this.issued.push({ csrPem, ...identity });
    this.serial += 1;
    const notBefore = new Date('2026-11-03T12:00:00Z');
    return Promise.resolve({
      certificatePem: `-----BEGIN CERTIFICATE-----\nNODE${String(this.serial)}\n-----END CERTIFICATE-----\n`,
      serial: this.serial.toString(16).padStart(4, '0'),
      notBefore,
      notAfter: new Date(notBefore.getTime() + 30 * 864e5),
    });
  }
}

export class FakeConfirmationKeys implements ConfirmationKeyProvider {
  publicKeyPem(): Promise<string> {
    return Promise.resolve('-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----\n');
  }
}

export const FAKE_CSR =
  '-----BEGIN CERTIFICATE REQUEST-----\nMIIB\n-----END CERTIFICATE REQUEST-----\n';
