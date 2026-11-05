// In-memory implementations of the fleet ports for unit tests.
import type { JoinTokenRecord } from '../domain/join-token';
import type { NodeCertificateRecord, NodeRecord } from '../domain/node';

import type {
  CertificateAuthority,
  ConfirmationKeyProvider,
  FleetTransaction,
  IssuedCertificate,
  JoinTokenStore,
  NodeStore,
} from './ports';

/** Runs work inline and records every database context it was asked to open, in order. */
export class RecordingTransaction implements FleetTransaction {
  readonly scopes: string[] = [];
  /** The innermost context, or `none` outside any scoped call. */
  current = 'none';
  run<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
  runTenant<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    return this.scoped(`tenant:${organizationId}`, work);
  }
  runEnrollment<T>(tokenHash: string, work: () => Promise<T>): Promise<T> {
    return this.scoped(`enrollment:${tokenHash}`, work);
  }
  private async scoped<T>(scope: string, work: () => Promise<T>): Promise<T> {
    this.scopes.push(scope);
    const previous = this.current;
    this.current = scope;
    try {
      return await work();
    } finally {
      this.current = previous;
    }
  }
}

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
  findById(organizationId: string, id: string): Promise<NodeRecord | undefined> {
    return Promise.resolve(
      this.nodes.find((node) => node.organizationId === organizationId && node.id === id),
    );
  }
  list(organizationId: string, beforeId?: string): Promise<NodeRecord[]> {
    return Promise.resolve(
      this.nodes
        .filter(
          (node) => node.organizationId === organizationId && (!beforeId || node.id < beforeId),
        )
        .sort((a, b) => b.id.localeCompare(a.id))
        .slice(0, 100),
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
  signConfirmation(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(64));
  }
  verifyConfirmation(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

export const FAKE_CSR =
  '-----BEGIN CERTIFICATE REQUEST-----\nMIIB\n-----END CERTIFICATE REQUEST-----\n';
