import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { StateReportSchema } from '@shipkeep/proto-ts';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { StateReports } from '../fleet/application/state-reports';
import { auditLog } from '../../testing/audit-log';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';

const report = (hostname: string, notAfter: Date, issuer: string) =>
  create(StateReportSchema, {
    certificates: [{ hostname, notAfter: timestampFromDate(notAfter), issuer }],
  });

/** SPEC 3.5, PLAN M3.6b2: each node's certificate for a domain, bound to its organization. */
describe('domain certificates with PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('keeps one reading per node, shows the one expiring first and audits each new certificate', async () => {
    const application = await fixture
      .post(`${fixture.environment}/applications`, 'owner', {
        config: {
          version: 1,
          name: 'certified-shop',
          build: { type: 'image', image: 'nginx:alpine' },
          run: { port: 80 },
          domains: ['shop.example.com', 'blog.example.com'],
        },
      })
      .expect(201);
    const applicationId = (application.body as { id: string }).id;
    const first = await enrollTestNode(fixture, { facts: { hostname: 'edge-cert-1.example.com' } });
    const second = await enrollTestNode(fixture, {
      facts: { hostname: 'edge-cert-2.example.com' },
    });
    const as = (nodeId: string, organizationId = fixture.organizationId) => ({
      organizationId,
      nodeId,
      serial: '',
    });
    const reports = fixture.app.get(StateReports);
    const soon = new Date(Date.now() + 20 * 86_400_000);
    const later = new Date(Date.now() + 80 * 86_400_000);
    const renewed = new Date(Date.now() + 90 * 86_400_000);

    await reports.deliver(as(first), report('shop.example.com', soon, 'R10'));
    await reports.deliver(as(second), report('SHOP.example.com.', later, 'R11'));
    // The same reading again is not a new certificate.
    await reports.deliver(as(first), report('shop.example.com', soon, 'R10'));
    // A node of another organization cannot write a reading for this one's domain.
    await reports.deliver(as(first, uuidv7()), report('shop.example.com', soon, 'Forged'));

    const listed = async () =>
      (
        await fixture
          .get(`${fixture.environment}/applications/${applicationId}/domains`, 'environmentViewer')
          .expect(200)
      ).body as { items: { hostname: string; certificate: unknown }[] };
    expect((await listed()).items).toEqual([
      expect.objectContaining({
        hostname: 'shop.example.com',
        certificate: {
          notAfter: soon.toISOString(),
          issuer: 'R10',
          observedAt: expect.any(String) as unknown,
        },
      }),
      expect.objectContaining({ hostname: 'blog.example.com', certificate: null }),
    ]);

    // Once the first node renews, the other node's certificate is the first to expire.
    await reports.deliver(as(first), report('shop.example.com', renewed, 'R10'));
    expect((await listed()).items[0]?.certificate).toEqual(
      expect.objectContaining({ notAfter: later.toISOString(), issuer: 'R11' }),
    );

    const admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
    try {
      const rows = await admin.query<{ node_id: string; issuer: string }>(
        'SELECT node_id, issuer FROM domain_certificates ORDER BY issuer',
      );
      expect(rows.rows).toEqual([
        { node_id: first, issuer: 'R10' },
        { node_id: second, issuer: 'R11' },
      ]);
      // A reading no node refreshed in the last hour no longer counts, even if it expires first.
      await admin.query(
        "UPDATE domain_certificates SET observed_at = now() - interval '2 hours' WHERE node_id = $1",
        [second],
      );
      expect((await listed()).items[0]?.certificate).toEqual(
        expect.objectContaining({ notAfter: renewed.toISOString(), issuer: 'R10' }),
      );
    } finally {
      await admin.end();
    }
    const events = await auditLog().findMany({
      where: { action: 'domain.certificate_observed' },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => [event.actorId, event.metadata])).toEqual([
      [first, expect.objectContaining({ notAfter: soon.toISOString(), previousNotAfter: null })],
      [second, expect.objectContaining({ notAfter: later.toISOString(), previousNotAfter: null })],
      [
        first,
        expect.objectContaining({
          notAfter: renewed.toISOString(),
          previousNotAfter: soon.toISOString(),
        }),
      ],
    ]);
  });
});
