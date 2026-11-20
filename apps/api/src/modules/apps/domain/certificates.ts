/**
 * Certificates that nodes report for the domains of applications (SPEC 3.5, PLAN M3.6b2). Each
 * node's Caddy holds its own certificate for a name, so a reading belongs to a domain and a node.
 */

/** What a node said it serves for a host name, once validated. */
export interface ReportedCertificate {
  readonly hostname: string;
  readonly notAfter: Date;
  readonly issuer: string;
}

/** A domain of the reporting node's organization. */
export interface CertificateDomain {
  readonly id: string;
  readonly applicationId: string;
  readonly hostname: string;
}

/** The last reading stored for a domain on the reporting node. */
export interface StoredCertificate {
  readonly domainId: string;
  readonly notAfter: Date;
  readonly issuer: string;
  readonly observedAt: Date;
}

export interface CertificateChange {
  readonly domain: CertificateDomain;
  readonly notAfter: Date;
  readonly issuer: string;
  /** False when only the time of the reading moves forward. */
  readonly changed: boolean;
  /** The reading it replaces, undefined for the first one. */
  readonly previous: Pick<StoredCertificate, 'notAfter' | 'issuer'> | undefined;
}

/** A reading that did not change is written again only this often, to keep writes low. */
export const CERTIFICATE_REFRESH_MS = 5 * 60_000;
/**
 * A reading older than this no longer counts: the node stopped serving the name, was removed,
 * or no longer reports. Agents report every 30 seconds.
 */
export const CERTIFICATE_STALE_MS = 60 * 60_000;

/**
 * What to store from one report. Names that are not domains of the organization are ignored, so
 * a node cannot create readings for anything else. The first reading of a name wins over a
 * duplicate in the same report.
 */
export function certificateChanges(
  domains: readonly CertificateDomain[],
  stored: readonly StoredCertificate[],
  reported: readonly ReportedCertificate[],
  now: Date,
): CertificateChange[] {
  const byHostname = new Map(domains.map((domain) => [domain.hostname, domain]));
  const seen = new Set<string>();
  const changes: CertificateChange[] = [];
  for (const reading of reported) {
    const domain = byHostname.get(reading.hostname);
    if (!domain || seen.has(domain.id)) continue;
    seen.add(domain.id);
    const previous = stored.find((row) => row.domainId === domain.id);
    const changed =
      !previous ||
      previous.notAfter.getTime() !== reading.notAfter.getTime() ||
      previous.issuer !== reading.issuer;
    if (!changed && now.getTime() - previous.observedAt.getTime() < CERTIFICATE_REFRESH_MS)
      continue;
    changes.push({
      domain,
      notAfter: reading.notAfter,
      issuer: reading.issuer,
      changed,
      previous: previous && { notAfter: previous.notAfter, issuer: previous.issuer },
    });
  }
  return changes;
}

export interface DomainCertificate {
  readonly notAfter: Date;
  readonly issuer: string;
  readonly observedAt: Date;
}

/**
 * The certificate to show for a domain: of the recent readings from every node, the one that
 * expires first, since that node is the first to break. Undefined when no node read one recently.
 */
export function domainCertificate(
  readings: readonly DomainCertificate[],
  now: Date,
): DomainCertificate | undefined {
  return readings
    .filter((reading) => now.getTime() - reading.observedAt.getTime() < CERTIFICATE_STALE_MS)
    .reduce<DomainCertificate | undefined>(
      (soonest, reading) =>
        !soonest || reading.notAfter.getTime() < soonest.notAfter.getTime() ? reading : soonest,
      undefined,
    );
}
