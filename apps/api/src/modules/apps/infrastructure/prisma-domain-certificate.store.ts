import { Injectable } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { DomainCertificateStore } from '../application/ports';
import type {
  CertificateChange,
  CertificateDomain,
  DomainCertificate,
  StoredCertificate,
} from '../domain/certificates';

/** Readings of every node for every domain of one application stay far below this bound. */
const MAX_READINGS = 5000;

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

  async forApplication(applicationId: string): Promise<Map<string, DomainCertificate[]>> {
    const rows = await this.database.client.domainCertificate.findMany({
      where: { domain: { applicationId } },
      select: {
        notAfter: true,
        issuer: true,
        observedAt: true,
        domain: { select: { hostname: true } },
      },
      orderBy: [{ domainId: 'asc' }, { nodeId: 'asc' }],
      take: MAX_READINGS,
    });
    const readings = new Map<string, DomainCertificate[]>();
    for (const { domain, ...reading } of rows) {
      readings.set(domain.hostname, [...(readings.get(domain.hostname) ?? []), reading]);
    }
    return readings;
  }
}
