import type {
  AgentActionChange,
  AgentActionEntry,
  AgentActionRecord,
} from '../domain/agent-action';
import type {
  AgentArchitecture,
  AgentUpgradeRecord,
  ReleaseVersion,
} from '../domain/agent-upgrade';
import type { JoinTokenRecord } from '../domain/join-token';
import type { NodeCertificateRecord, NodeFacts, NodeRecord, NodeStatus } from '../domain/node';
import type { NodeCredential, NodeIdentity } from '../domain/node-identity';
import type { ReadoptionRequest } from '../domain/node-readoption';

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

/** Certificates waiting to be re-adopted (#487); every method runs under `runTenant`. */
export interface NodeReadoptionStore {
  find(organizationId: string, nodeId: string): Promise<ReadoptionRequest | undefined>;
  list(organizationId: string): Promise<ReadoptionRequest[]>;
  /** Records the node's request, or replaces it. */
  save(request: ReadoptionRequest): Promise<void>;
  /**
   * Registers the request's certificate for its node, revokes every other current certificate of
   * the node and deletes the request, in the caller's transaction. Returns the revoked serials.
   */
  adopt(request: ReadoptionRequest, certificateId: string, now: Date): Promise<string[]>;
}

export const NODE_CREDENTIAL_STORE = Symbol('NodeCredentialStore');
export const NODE_READOPTION_STORE = Symbol('NodeReadoptionStore');
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
  /**
   * Run under `runTenant(organizationId)`: locks the node's row until the transaction ends, so that
   * action admissions on one node happen one at a time. False when the node does not exist.
   */
  lockForAdmission(organizationId: string, id: string): Promise<boolean>;
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

/** The public half of the registry's signing key, as Distribution reads it from a JWKS file. */
export interface RegistryPublicKey {
  /** The `kid` a token's header names: the SHA-256 of the key's SPKI encoding, base64url. */
  readonly keyId: string;
  readonly jwk: { readonly kty: 'OKP'; readonly crv: 'Ed25519'; readonly x: string };
}

/** Ed25519 key pair that signs the tokens of the installation's registry (ADR 0030). */
export interface RegistryTokenKeyProvider {
  registryKey(): Promise<RegistryPublicKey>;
  /** Signs with the private half, which never leaves the key provider. */
  signRegistryToken(input: Uint8Array): Promise<Uint8Array>;
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
  /**
   * The organization's action with this key, whichever node it went to, locked until the
   * transaction ends. A deployment's keys name it (`d:<deployment>:…`), so they are its own.
   */
  lockByKey(organizationId: string, key: string): Promise<AgentActionRecord | undefined>;
  /** Replaces an action's payload, encrypted as when it was queued. */
  replacePayload(organizationId: string, id: string, payload: Uint8Array): Promise<void>;
  /** Non-terminal actions whose deadline is still ahead, oldest first, at most 100. */
  deliverable(organizationId: string, nodeId: string, now: Date): Promise<AgentActionRecord[]>;
  /** Whether the node has an unfinished action, other than `exceptId`, whose deadline is ahead. */
  hasUnfinished(
    organizationId: string,
    nodeId: string,
    exceptId: string | null,
    now: Date,
  ): Promise<boolean>;
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
  /** The deployment's actions, oldest first, at most `limit`. */
  forDeployment(
    organizationId: string,
    deploymentId: string,
    limit: number,
  ): Promise<AgentActionEntry[]>;
}
export const AGENT_ACTION_STORE = Symbol('AgentActionStore');

export const JOIN_TOKEN_STORE = Symbol('JoinTokenStore');
export const NODE_STORE = Symbol('NodeStore');
export const CERTIFICATE_AUTHORITY = Symbol('CertificateAuthority');
export const CONFIRMATION_KEY_PROVIDER = Symbol('ConfirmationKeyProvider');
export const REGISTRY_TOKEN_KEY = Symbol('RegistryTokenKeyProvider');

/**
 * What the control plane relays in an UpgradeAgent: the archive's address, its SHA-256 and its
 * Sigstore bundle, as the release publishes them (ADR 0028). The agent checks all of it itself.
 */
export interface AgentRelease {
  readonly url: string;
  /** Lowercase hex. */
  readonly sha256: string;
  readonly bundleJson: Uint8Array;
}
/** Reads agent releases from where `release.yml` publishes them. */
export interface AgentReleases {
  /** The release of `version` for `architecture`; null when it cannot be read, for any reason. */
  find(version: ReleaseVersion, architecture: AgentArchitecture): Promise<AgentRelease | null>;
}
export const AGENT_RELEASES = Symbol('AgentReleases');

/** The changes a rollout's turn makes; every method runs inside `runTenant`. */
export interface AgentUpgradeChange {
  readonly state: AgentUpgradeRecord['state'];
  readonly position: number;
  readonly actionId: string | null;
  readonly turnStartedAt: Date;
  readonly failure: AgentUpgradeRecord['failure'];
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}
export interface AgentUpgradeStore {
  /** False when another rollout of the organization is running. */
  insert(record: AgentUpgradeRecord): Promise<boolean>;
  findById(organizationId: string, id: string): Promise<AgentUpgradeRecord | undefined>;
  /** The organization's newest rollout, running or not. */
  latest(organizationId: string): Promise<AgentUpgradeRecord | undefined>;
  findRunning(organizationId: string): Promise<AgentUpgradeRecord | undefined>;
  /**
   * Compare-and-swap of a running rollout, on the position and action just read: undefined when
   * another run changed it first.
   */
  update(
    organizationId: string,
    id: string,
    expected: Pick<AgentUpgradeRecord, 'position' | 'actionId'>,
    change: AgentUpgradeChange,
  ): Promise<AgentUpgradeRecord | undefined>;
}
export const AGENT_UPGRADE_STORE = Symbol('AgentUpgradeStore');

export const EXEC_SESSION_CHECKS = Symbol('ExecSessionChecks');
/**
 * Queues an exec session's audit check, in the transaction that records its opening: once the
 * session must have ended, a missing end is recorded as an interruption (issue #489).
 */
export interface ExecSessionCheckScheduler {
  schedule(session: {
    id: string;
    organizationId: string;
    userId: string;
    endsAt: Date;
  }): Promise<void>;
}
