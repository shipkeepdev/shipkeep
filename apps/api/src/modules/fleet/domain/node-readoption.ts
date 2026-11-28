import { ConflictError, NotFoundError } from '@shipkeep/domain';

import type { NodeStatus } from './node';
import type { NodeIdentity } from './node-identity';

/**
 * Re-adoption (#487, SPEC 3.1). The gateway trusts only certificates its registry knows. After a
 * restore from a backup older than a node's last renewal, the agent presents a certificate the
 * installation CA signed but the restored registry never saw, and is refused. The gateway then
 * records that certificate for its node, and an administrator who confirms registers it: the same
 * node, with its allocations, comes back. Nothing here accepts a certificate by itself.
 */
export interface ReadoptionRequest extends NodeIdentity {
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

/** The validity of the certificate the agent presented, read from the TLS handshake. */
export interface PresentedValidity {
  readonly notBefore: Date;
  readonly notAfter: Date;
}

/** A refused agent retries: its presentation is written again at most this often. */
export const READOPTION_REFRESH_MS = 60_000;

/**
 * Whether a refused certificate is worth recording: unknown to the registry (a known serial was
 * revoked or expired on purpose, and stays refused), current, and for a node of its organization
 * that was not removed.
 */
export function worthRecording(
  known: boolean,
  presented: PresentedValidity,
  node: { readonly status: NodeStatus } | undefined,
  now: Date,
): boolean {
  return (
    !known &&
    presented.notBefore <= now &&
    presented.notAfter > now &&
    node !== undefined &&
    node.status !== 'removed'
  );
}

/** What a presentation does to the recorded request: a new one is audited, a refresh is not. */
export function presentationOutcome(
  recorded: ReadoptionRequest | undefined,
  serial: string,
  now: Date,
): 'record' | 'refresh' | 'none' {
  if (!recorded || recorded.serial !== serial) return 'record';
  return now.getTime() - recorded.lastSeenAt.getTime() >= READOPTION_REFRESH_MS
    ? 'refresh'
    : 'none';
}

export class ReadoptionNotPendingError extends ConflictError {
  constructor() {
    super('readoption_not_pending', 'this server has no certificate waiting to be re-adopted');
  }
}

/**
 * The waiting certificate is not the one the administrator reviewed (#545): another one replaced it
 * meanwhile, which may be a stolen certificate presented again. Nothing is adopted; the
 * administrator reviews the request again.
 */
export class ReadoptionChangedError extends ConflictError {
  constructor() {
    super(
      'readoption_changed',
      'the certificate waiting for this server is not the one reviewed: review it again',
    );
  }
}

export class ReadoptionExpiredError extends ConflictError {
  constructor() {
    super(
      'readoption_certificate_expired',
      'the certificate waiting to be re-adopted has expired: install the server again',
    );
  }
}

/**
 * The request an administrator confirms: still there, for the certificate they reviewed
 * (`reviewedSerial`), still current, for a node not removed.
 */
export function readoptable(
  request: ReadoptionRequest | undefined,
  node: { readonly status: NodeStatus } | undefined,
  now: Date,
  reviewedSerial: string,
): ReadoptionRequest {
  if (!node) throw new NotFoundError('node');
  if (!request || node.status === 'removed') throw new ReadoptionNotPendingError();
  if (request.serial !== reviewedSerial) throw new ReadoptionChangedError();
  if (request.notAfter <= now || request.notBefore > now) throw new ReadoptionExpiredError();
  return request;
}
