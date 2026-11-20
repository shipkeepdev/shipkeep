import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { StateReportSchema } from '@shipkeep/proto-ts';

import type { DomainEvent } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { StateReports } from '../../fleet/application/state-reports';
import type { CertificateChange, StoredCertificate } from '../domain/certificates';

import { DomainCertificates, reportedCertificates } from './domain-certificates';
import type { DomainCertificateStore } from './ports';

const notAfter = new Date('2027-02-18T00:00:00Z');
const report = (
  ...certificates: { hostname: string; notAfter?: Date | undefined; issuer?: string }[]
) =>
  create(StateReportSchema, {
    certificates: certificates.map((certificate) => ({
      hostname: certificate.hostname,
      notAfter: certificate.notAfter && timestampFromDate(certificate.notAfter),
      issuer: certificate.issuer ?? 'R11',
    })),
  });

describe('reportedCertificates', () => {
  it('reads names without case or a trailing dot', () => {
    expect(
      reportedCertificates(
        report(
          { hostname: 'Shop.Example.COM.', notAfter },
          { hostname: '*.example.com', notAfter, issuer: "Let's Encrypt" },
        ),
      ),
    ).toEqual([
      { hostname: 'shop.example.com', notAfter, issuer: 'R11' },
      { hostname: '*.example.com', notAfter, issuer: "Let's Encrypt" },
    ]);
    expect(reportedCertificates(report())).toEqual([]);
  });

  it.each([
    ['a path', { hostname: '../../etc/passwd', notAfter }],
    ['an injection', { hostname: "shop.example.com'; DROP TABLE domains;--", notAfter }],
    ['a space', { hostname: 'shop example.com', notAfter }],
    ['an empty label', { hostname: 'shop..example.com', notAfter }],
    ['an empty name', { hostname: '', notAfter }],
    ['an oversized name', { hostname: `${'a'.repeat(63)}.`.repeat(4) + 'com', notAfter }],
    ['a label over 63 bytes', { hostname: `${'a'.repeat(64)}.example.com`, notAfter }],
    ['a label starting with a hyphen', { hostname: '-shop.example.com', notAfter }],
    ['a label ending with a hyphen', { hostname: 'shop-.example.com', notAfter }],
    ['a single label', { hostname: 'localhost', notAfter }],
    ['a wildcard inside the name', { hostname: 'shop.*.example.com', notAfter }],
    ['no expiry', { hostname: 'shop.example.com', notAfter: undefined }],
    ['an expiry before 2000', { hostname: 'shop.example.com', notAfter: new Date(0) }],
    ['an expiry after 2200', { hostname: 'shop.example.com', notAfter: new Date('2300-01-01') }],
    ['an oversized issuer', { hostname: 'shop.example.com', notAfter, issuer: 'é'.repeat(33) }],
    ['a control character', { hostname: 'shop.example.com', notAfter, issuer: 'R11\n[fake]' }],
    ['a C1 control', { hostname: 'shop.example.com', notAfter, issuer: 'R11\u009b' }],
  ])('refuses the whole list for %s', (_, certificate) => {
    expect(
      reportedCertificates(report({ hostname: 'blog.example.com', notAfter }, certificate)),
    ).toBeUndefined();
  });

  it('refuses more names than an agent reports', () => {
    const many = Array.from({ length: 65 }, (_, index) => ({
      hostname: `app${String(index)}.example.com`,
      notAfter,
    }));
    expect(reportedCertificates(report(...many))).toBeUndefined();
    expect(reportedCertificates(report(...many.slice(0, 64)))).toHaveLength(64);
  });
});

describe('DomainCertificates', () => {
  const identity = { organizationId: 'org-1', nodeId: 'node-1', serial: '' };
  const shop = { id: 'd-shop', applicationId: 'app-1', hostname: 'shop.example.com' };

  function setup(stored: StoredCertificate[] = []) {
    const applied: CertificateChange[][] = [];
    const tenants: string[] = [];
    const store: DomainCertificateStore = {
      onNode: (_organizationId, _nodeId, hostnames) =>
        Promise.resolve({
          domains: hostnames.includes(shop.hostname) ? [shop] : [],
          stored,
        }),
      apply: (_organizationId, _nodeId, changes) => {
        applied.push([...changes]);
        return Promise.resolve();
      },
      forApplication: () => Promise.resolve(new Map()),
    };
    const events = new DomainEventBus();
    const published: DomainEvent[] = [];
    events.subscribe((event) => {
      published.push(event);
      return Promise.resolve();
    });
    const reports = new StateReports();
    const certificates = new DomainCertificates(
      store,
      {
        runTenant: (organizationId, work) => {
          tenants.push(organizationId);
          return work();
        },
      },
      reports,
      events,
    );
    certificates.onModuleInit();
    return { reports, applied, tenants, published };
  }

  it('stores and audits a new certificate in the node organization only', async () => {
    const { reports, applied, tenants, published } = setup();
    await reports.deliver(identity, report({ hostname: 'shop.example.com', notAfter }));
    expect(tenants).toEqual(['org-1']);
    expect(applied).toHaveLength(1);
    expect(published).toEqual([
      expect.objectContaining({
        type: 'domain.certificate_observed',
        organizationId: 'org-1',
        actor: { kind: 'node', id: 'node-1' },
        target: { type: 'application', id: 'app-1' },
        payload: expect.objectContaining({
          hostname: 'shop.example.com',
          notAfter: notAfter.toISOString(),
          previousNotAfter: null,
        }),
      }),
    ]);
  });

  it('refreshes an unchanged reading without an audit event', async () => {
    const { reports, applied, published } = setup([
      { domainId: shop.id, notAfter, issuer: 'R11', observedAt: new Date(0) },
    ]);
    await reports.deliver(identity, report({ hostname: 'shop.example.com', notAfter }));
    expect(applied).toEqual([[expect.objectContaining({ changed: false })]]);
    expect(published).toEqual([]);
  });

  it('writes nothing for an invalid, empty or foreign report', async () => {
    const { reports, tenants, applied } = setup();
    await reports.deliver(identity, report({ hostname: '../shop', notAfter }));
    await reports.deliver(identity, report());
    expect(tenants).toEqual([]);
    await reports.deliver(identity, report({ hostname: 'bank.example.net', notAfter }));
    expect(applied).toEqual([]);
  });
});
