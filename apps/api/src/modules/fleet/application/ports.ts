import type {
  AgentActionChange,
  AgentActionEntry,
  AgentActionRecord,
} from '../domain/agent-action';
import type { JoinTokenRecord } from '../domain/join-token';
import type { NodeCertificateRecord, NodeFacts, NodeRecord, NodeStatus } from '../domain/node';
import type { NodeCredential, NodeIdentity } from '../domain/node-identity';

export interface NodeCredentialStore {
  /** Looks the serial up inside `organizationId` only (the organization of the TLS identity). */
  find(organizationId: string, serial: string): Promise<NodeCredential | undefined>;
  /** Compare-and-swap: only a still-current certificate may be replaced. */
  replace(identity: NodeIdentity, certificate: NodeCertificateRecord, now: Date): Promise<boolean>;
}

export interface FleetTransaction {
  run<T>(work: () => Promise<T>): Promise<T>;
  /** Tenant row security context: only rows of `organizationId` are visible and writable. */
  runTenant<T>(organizationId: string, work: () => Promise<T>): Promise<T>;
  /** Only the join token with this hash is visible, read-only (ADR 0015). */
  runEnrollment<T>(tokenHash: string, work: () => Promise<T>): Promise<T>;
}

export const NODE_CREDENTIAL_STORE = Symbol('NodeCredentialStore');
export const FLEET_TRANSACTION = Symbol('FleetTransaction');

export interface JoinTokenStore {
  insert(record: JoinTokenRecord): Promise<void>;
  findByHash(tokenHash: string): Promise<JoinTokenRecord | undefined>;
  /**
   * Marks the token used by a node. Returns false when it was already used, so two concurrent
   * enrollments with the same token cannot both succeed.
   */
  consume(id: string, nodeId: string, usedAt: Date): Promise<boolean>;
}

export interface NodeStore {
  insert(node: NodeRecord): Promise<void>;
  findByName(organizationId: string, name: string): Promise<NodeRecord | undefined>;
  insertCertificate(certificate: NodeCertificateRecord): Promise<void>;
  /** Run under `runTenant(organizationId)`. */
  findById(organizationId: string, id: string): Promise<NodeRecord | undefined>;
  /**
   * Run under `runTenant(organizationId)`: marks the node removed and revokes every current
   * certificate. False when the node was already removed.
   */
  remove(organizationId: string, id: string, now: Date): Promise<boolean>;
  /**
   * Run under `runTenant(organizationId)`: records a heartbeat and the status it implies if the
   * node is still in `expected`. False when the status changed meanwhile.
   */
  heartbeat(
    organizationId: string,
    id: string,
    expected: NodeStatus,
    next: NodeStatus,
    now: Date,
  ): Promise<boolean>;
  /** Run under `runTenant(organizationId)`: replaces the facts of a node that is not removed. */
  updateFacts(organizationId: string, id: string, facts: NodeFacts): Promise<void>;
  /**
   * Run under `runTenant(organizationId)`: compare-and-swap of the declared public addresses of a
   * node that is not removed. Returns the updated node, or undefined when the node is gone or its
   * addresses are no longer `expected`, so concurrent edits never audit a stale previous list.
   */
  setPublicAddresses(
    organizationId: string,
    id: string,
    expected: readonly string[],
    addresses: readonly string[],
  ): Promise<NodeRecord | undefined>;
  /** Run under `runTenant(organizationId)`: at most 100 nodes, newest first, exclusive cursor. */
  list(organizationId: string, beforeId?: string): Promise<NodeRecord[]>;
}

export interface IssuedCertificate {
  readonly certificatePem: string;
  /** Hex serial. */
  readonly serial: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

/** The installation CA (SPEC section 3.2). Implemented in infrastructure; the domain never sees keys. */
export interface CertificateAuthority {
  /** PEM of the CA certificate agents pin. */
  caCertificatePem(): Promise<string>;
  /** `sha256:<64 hex>` of the DER CA certificate, shown in the install command. */
  caFingerprint(): Promise<string>;
  /**
   * Signs a node client certificate from the CSR's public key. The CSR signature must verify;
   * every name and extension comes from the arguments, never from the CSR.
   */
  issueNodeCertificate(
    csrPem: string,
    identity: { organizationId: string; nodeId: string },
  ): Promise<IssuedCertificate>;
}

/** Ed25519 key pair that signs confirmation tokens (SPEC section 3.6); agents receive the public half. */
export interface ConfirmationKeyProvider {
  publicKeyPem(): Promise<string>;
  /** Signs with the private half, which never leaves the key provider. */
  signConfirmation(input: Uint8Array): Promise<Uint8Array>;
  verifyConfirmation(input: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

/** Every method runs inside `runTenant` for the action's organization. */
export interface AgentActionStore {
  /** False when the node already has an action with this idempotency key. */
  insert(record: AgentActionRecord): Promise<boolean>;
  findByKey(
    organizationId: string,
    nodeId: string,
    key: string,
  ): Promise<AgentActionRecord | undefined>;
  /** Non-terminal actions whose deadline is still ahead, oldest first, at most 100. */
  deliverable(organizationId: string, nodeId: string, now: Date): Promise<AgentActionRecord[]>;
  /** Marks overdue non-terminal actions `expired` and returns them. */
  expire(organizationId: string, nodeId: string, now: Date): Promise<AgentActionRecord[]>;
  /** Applies a change unless the action is terminal; returns the updated action, if any. */
  apply(
    organizationId: string,
    nodeId: string,
    id: string,
    change: AgentActionChange,
  ): Promise<AgentActionRecord | undefined>;
  /** The application's actions, newest first, ids below `beforeId` when given. */
  forApplication(
    organizationId: string,
    applicationId: string,
    beforeId: string | undefined,
    limit: number,
  ): Promise<AgentActionEntry[]>;
}
export const AGENT_ACTION_STORE = Symbol('AgentActionStore');

export const JOIN_TOKEN_STORE = Symbol('JoinTokenStore');
export const NODE_STORE = Symbol('NodeStore');
export const CERTIFICATE_AUTHORITY = Symbol('CertificateAuthority');
export const CONFIRMATION_KEY_PROVIDER = Symbol('ConfirmationKeyProvider');
