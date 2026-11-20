import { Injectable } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { DomainCertificateStore } from '../application/ports';
import type {
  CertificateChange,
  CertificateDomain,
  DomainCertificate,
  StoredCertificate,
} from '../domain/certificates';

@Injectable()
export class PrismaDomainCertificateStore implements DomainCertificateStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async onNode(
    organizationId: string,
    nodeId: string,
    hostnames: readonly string[],
  ): Promise<{ domains: CertificateDomain[]; stored: StoredCertificate[] }> {
    const domains = await this.database.client.domain.findMany({
      where: { organizationId, hostname: { in: [...hostnames] } },
      select: { id: true, applicationId: true, hostname: true },
    });
    const stored = await this.database.client.domainCertificate.findMany({
      where: { organizationId, nodeId, domainId: { in: domains.map((domain) => domain.id) } },
      select: { domainId: true, notAfter: true, issuer: true, observedAt: true },
    });
    return { domains, stored };
  }

  async apply(
    organizationId: string,
    nodeId: string,
    changes: readonly CertificateChange[],
    now: Date,
  ): Promise<void> {
    for (const change of changes) {
      const reading = { notAfter: change.notAfter, issuer: change.issuer, observedAt: now };
      await this.database.client.domainCertificate.upsert({
        where: { domainId_nodeId: { domainId: change.domain.id, nodeId } },
        create: { organizationId, domainId: change.domain.id, nodeId, ...reading },
        update: reading,
      });
    }
  }

  async forApplication(
    organizationId: string,
    applicationId: string,
    freshSince: Date,
  ): Promise<Map<string, DomainCertificate>> {
    // One row per domain, whatever the number of nodes: the recent reading that expires first.
    const rows = await this.database.client.$queryRaw<
      { hostname: string; notAfter: Date; issuer: string; observedAt: Date }[]
    >`
      SELECT DISTINCT ON (c.domain_id)
        d.hostname, c.not_after AS "notAfter", c.issuer, c.observed_at AS "observedAt"
      FROM domain_certificates c
      JOIN domains d ON d.organization_id = c.organization_id AND d.id = c.domain_id
      WHERE c.organization_id = ${organizationId}::uuid
        AND d.application_id = ${applicationId}::uuid
        AND c.observed_at > ${freshSince}
      ORDER BY c.domain_id, c.not_after ASC, c.node_id ASC
    `;
    return new Map(rows.map(({ hostname, ...reading }) => [hostname, reading] as const));
  }
}
