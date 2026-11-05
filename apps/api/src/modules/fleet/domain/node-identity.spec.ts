import { authenticateCertificate, NodeAuthenticationError } from './node-identity';

const identity = { organizationId: 'org-a', nodeId: 'node-a', serial: '01' };
const now = new Date('2026-11-03T12:00:00Z');
const credential = {
  ...identity,
  status: 'enrolling' as const,
  leaseEpoch: 1,
  notBefore: new Date(now.getTime() - 1000),
  notAfter: new Date(now.getTime() + 1000),
  revokedAt: null,
};

describe('authenticateCertificate', () => {
  it('accepts a registered, current certificate for its own node and organization', () => {
    expect(authenticateCertificate(identity, credential, now)).toEqual(credential);
  });

  it.each([
    undefined,
    { ...credential, organizationId: 'org-b' },
    { ...credential, nodeId: 'node-b' },
    { ...credential, serial: '02' },
    { ...credential, status: 'removed' as const },
    { ...credential, revokedAt: now },
    { ...credential, notBefore: new Date(now.getTime() + 1) },
    { ...credential, notAfter: now },
  ])('rejects unknown, mismatched, removed, revoked or expired identities', (record) => {
    expect(() => authenticateCertificate(identity, record, now)).toThrow(NodeAuthenticationError);
  });
});
