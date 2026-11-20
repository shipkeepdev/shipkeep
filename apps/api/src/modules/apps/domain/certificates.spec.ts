import { CERTIFICATE_REFRESH_MS, certificateChanges } from './certificates';

const now = new Date('2026-11-20T12:00:00Z');
const later = (ms: number) => new Date(now.getTime() + ms);
const shop = { id: 'd-shop', applicationId: 'app', hostname: 'shop.example.com' };
const blog = { id: 'd-blog', applicationId: 'app', hostname: 'blog.example.com' };
const expiry = new Date('2027-02-18T00:00:00Z');

describe('certificateChanges', () => {
  it('stores a first reading as a change, with no previous one', () => {
    expect(
      certificateChanges(
        [shop, blog],
        [],
        [{ hostname: 'shop.example.com', notAfter: expiry, issuer: 'R11' }],
        now,
      ),
    ).toEqual([
      { domain: shop, notAfter: expiry, issuer: 'R11', changed: true, previous: undefined },
    ]);
  });

  it('ignores names that are not domains of the organization', () => {
    expect(
      certificateChanges(
        [shop],
        [],
        [{ hostname: 'bank.example.net', notAfter: expiry, issuer: 'R11' }],
        now,
      ),
    ).toEqual([]);
  });

  it('keeps the first reading of a name reported twice', () => {
    const changes = certificateChanges(
      [shop],
      [],
      [
        { hostname: 'shop.example.com', notAfter: expiry, issuer: 'R11' },
        { hostname: 'shop.example.com', notAfter: now, issuer: 'Forged' },
      ],
      now,
    );
    expect(changes.map((change) => change.issuer)).toEqual(['R11']);
  });

  it('writes an unchanged reading again only once it is old enough', () => {
    const stored = [{ domainId: shop.id, notAfter: expiry, issuer: 'R11', observedAt: now }];
    const reported = [{ hostname: shop.hostname, notAfter: expiry, issuer: 'R11' }];
    expect(certificateChanges([shop], stored, reported, later(CERTIFICATE_REFRESH_MS - 1))).toEqual(
      [],
    );
    expect(certificateChanges([shop], stored, reported, later(CERTIFICATE_REFRESH_MS))).toEqual([
      {
        domain: shop,
        notAfter: expiry,
        issuer: 'R11',
        changed: false,
        previous: { notAfter: expiry, issuer: 'R11' },
      },
    ]);
  });

  it('reports a renewal or a new issuer as a change at once', () => {
    const stored = [{ domainId: shop.id, notAfter: now, issuer: 'R10', observedAt: now }];
    const renewed = certificateChanges(
      [shop],
      stored,
      [{ hostname: shop.hostname, notAfter: expiry, issuer: 'R10' }],
      later(1),
    );
    expect(renewed).toEqual([
      expect.objectContaining({ changed: true, previous: { notAfter: now, issuer: 'R10' } }),
    ]);
    const reissued = certificateChanges(
      [shop],
      stored,
      [{ hostname: shop.hostname, notAfter: now, issuer: 'E6' }],
      later(1),
    );
    expect(reissued).toEqual([expect.objectContaining({ changed: true, issuer: 'E6' })]);
  });
});
