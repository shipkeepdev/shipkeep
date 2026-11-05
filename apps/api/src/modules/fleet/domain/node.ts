import { InvalidInputError } from '@shipkeep/domain';

/** Node lifecycle (SPEC section 5.2). */
export type NodeStatus = 'enrolling' | 'ready' | 'suspect' | 'down' | 'draining' | 'removed';

/** Hardware and software facts reported by the agent (proto `NodeFacts`), as stored. */
export type NodeFacts = Readonly<Record<string, string | number>>;

export interface NodeRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly status: NodeStatus;
  readonly labels: Readonly<Record<string, string>>;
  readonly facts: NodeFacts;
  readonly leaseEpoch: number;
  readonly createdAt: Date;
  readonly lastHeartbeatAt: Date | null;
}

export interface NodeCertificateRecord {
  readonly id: string;
  /** Always the node's organization (composite foreign key). */
  readonly organizationId: string;
  readonly nodeId: string;
  /** Hex serial, unique per installation CA. */
  readonly serial: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly revokedAt: Date | null;
}

const NODE_NAME_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const MAX_FACT_STRING = 256;
const MAX_FACTS = 64;

export function assertNodeName(name: string): void {
  if (!NODE_NAME_RE.test(name)) {
    throw new InvalidInputError(
      'node_name_invalid',
      'node name must match ^[a-z][a-z0-9-]{1,38}[a-z0-9]$',
      {
        name,
      },
    );
  }
}

/** Derives a valid node name from a hostname reported by the agent, or undefined. */
export function nodeNameFromHostname(hostname: string): string | undefined {
  const candidate = hostname
    .toLowerCase()
    .split('.')[0]
    ?.replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return candidate && NODE_NAME_RE.test(candidate) ? candidate : undefined;
}

/**
 * Keeps only well-typed facts of bounded size. Agents are trusted for their own facts but never
 * for the shape of what reaches the database (THREAT_MODEL E2).
 */
export function sanitizeFacts(input: Readonly<Record<string, unknown>>): NodeFacts {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input).slice(0, MAX_FACTS)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'bigint') {
      out[key] = Number(value);
    } else if (typeof value === 'string' && value.length > 0) {
      out[key] = value.slice(0, MAX_FACT_STRING);
    }
  }
  return out;
}

/** SPIFFE identity encoded in every node certificate (SPEC section 3.2). */
export function nodeSpiffeId(organizationId: string, nodeId: string): string {
  return `spiffe://shipkeep/${organizationId}/node/${nodeId}`;
}

const SPIFFE_RE = /^spiffe:\/\/shipkeep\/([0-9a-f-]{36})\/node\/([0-9a-f-]{36})$/;

export function parseNodeSpiffeId(
  uri: string,
): { organizationId: string; nodeId: string } | undefined {
  const match = SPIFFE_RE.exec(uri);
  if (!match?.[1] || !match[2]) return undefined;
  return { organizationId: match[1], nodeId: match[2] };
}
