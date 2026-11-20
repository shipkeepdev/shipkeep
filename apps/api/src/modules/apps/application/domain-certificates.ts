import { timestampDate } from '@bufbuild/protobuf/wkt';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createEvent } from '@shipkeep/domain';
import type { StateReport } from '@shipkeep/proto-ts';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { StateReports } from '../../fleet/application/state-reports';
import type { NodeIdentity } from '../../fleet/domain/node-identity';
import { certificateChanges, type ReportedCertificate } from '../domain/certificates';

import {
  APPLICATION_TRANSACTION,
  type ApplicationTransaction,
  DOMAIN_CERTIFICATE_STORE,
  type DomainCertificateStore,
} from './ports';

/** The agent reports at most this many names (certwatch.MaxHosts). */
const MAX_CERTIFICATES = 64;
const MAX_ISSUER_BYTES = 64;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Certificates outside this range are not ones a public or internal CA issues.
const EARLIEST = Date.UTC(2000, 0, 1);
const LATEST = Date.UTC(2200, 0, 1);

/**
 * The report's certificates, or undefined when any is invalid: a tampered or broken agent never
 * gets a partial list stored. Names are compared without case or a trailing dot.
 */
export function reportedCertificates(report: StateReport): ReportedCertificate[] | undefined {
  if (report.certificates.length > MAX_CERTIFICATES) return undefined;
  const certificates: ReportedCertificate[] = [];
  for (const certificate of report.certificates) {
    const hostname = certificate.hostname.toLowerCase().replace(/\.$/, '');
    if (!validHostname(hostname)) return undefined;
    if (!certificate.notAfter) return undefined;
    const notAfter = timestampDate(certificate.notAfter);
    const time = notAfter.getTime();
    if (!Number.isFinite(time) || time < EARLIEST || time > LATEST) return undefined;
    const issuer = certificate.issuer;
    if (Buffer.byteLength(issuer, 'utf8') > MAX_ISSUER_BYTES || hasControl(issuer))
      return undefined;
    certificates.push({ hostname, notAfter, issuer });
  }
  return certificates;
}

/** A DNS name of at most 253 bytes, each label of 1 to 63, a leading `*` label allowed. */
function validHostname(hostname: string): boolean {
  if (hostname.length > 253) return false;
  const labels = hostname.split('.');
  if (labels[0] === '*') labels.shift();
  return labels.length >= 2 && labels.every((label) => LABEL.test(label));
}

function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return true;
  }
  return false;
}

/**
 * Records the certificates a node's Caddy serves for the domains of its organization (SPEC 3.5,
 * PLAN M3.6b2), and audits each new certificate. The identity comes from the node's client
 * certificate and the write runs in its organization, so a report cannot touch another one.
 */
@Injectable()
export class DomainCertificates implements OnModuleInit {
  private readonly logger = new Logger(DomainCertificates.name);

  constructor(
    @Inject(DOMAIN_CERTIFICATE_STORE) private readonly store: DomainCertificateStore,
    @Inject(APPLICATION_TRANSACTION) private readonly transaction: ApplicationTransaction,
    private readonly reports: StateReports,
    private readonly events: DomainEventBus,
  ) {}

  onModuleInit(): void {
    this.reports.register((identity, report) => this.record(identity, report));
  }

  async record(identity: NodeIdentity, report: StateReport, now = new Date()): Promise<void> {
    const reported = reportedCertificates(report);
    if (!reported) {
      // The agent bounds and cleans its readings, so this is a bug or a tampered agent.
      this.logger.warn({ nodeId: identity.nodeId }, 'invalid certificate report ignored');
      return;
    }
    if (!reported.length) return;
    await this.transaction.runTenant(identity.organizationId, async () => {
      const { domains, stored } = await this.store.onNode(
        identity.organizationId,
        identity.nodeId,
        reported.map((certificate) => certificate.hostname),
      );
      const changes = certificateChanges(domains, stored, reported, now);
      if (!changes.length) return;
      await this.store.apply(identity.organizationId, identity.nodeId, changes, now);
      const events = changes
        .filter((change) => change.changed)
        .map((change) =>
          createEvent({
            type: 'domain.certificate_observed',
            organizationId: identity.organizationId,
            actor: { kind: 'node', id: identity.nodeId },
            target: { type: 'application', id: change.domain.applicationId },
            payload: {
              applicationId: change.domain.applicationId,
              hostname: change.domain.hostname,
              nodeId: identity.nodeId,
              notAfter: change.notAfter.toISOString(),
              issuer: change.issuer,
              previousNotAfter: change.previous?.notAfter.toISOString() ?? null,
            },
            occurredAt: now,
          }),
        );
      if (events.length) await this.events.publish(events);
    });
  }
}
