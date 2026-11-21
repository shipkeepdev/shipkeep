import { TestBed } from '@angular/core/testing';

import { AccessApi, type Member, type OrganizationRole } from './access-api';
import { isTransferTarget, TransferTargets } from './transfer-targets';

const ORG = '01900000-0000-7000-8000-000000000001';
const member = (id: string, orgRole: OrganizationRole, active = true): Member => ({
  id,
  email: `${id}@example.com`,
  orgRole,
  active,
  organizationId: ORG,
  userId: `u-${id}`,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
});

describe('transfer targets', () => {
  it('keeps only active admins', () => {
    expect(isTransferTarget(member('a', 'admin'))).toBe(true);
    expect(isTransferTarget(member('b', 'admin', false))).toBe(false);
    expect(isTransferTarget(member('c', 'owner'))).toBe(false);
    expect(isTransferTarget(member('d', 'member'))).toBe(false);
  });

  it('reads ten pages at most and says where to continue', async () => {
    // Page n holds one member; page 12 holds the only admin.
    const members = vi.fn<AccessApi['members']>((_org, cursor) => {
      const n = cursor ? Number(cursor) : 1;
      return Promise.resolve({
        items: [member(`m${String(n)}`, n === 12 ? 'admin' : 'member')],
        nextCursor: n < 12 ? String(n + 1) : null,
      } as never);
    });
    TestBed.configureTestingModule({ providers: [{ provide: AccessApi, useValue: { members } }] });
    const targets = TestBed.inject(TransferTargets);
    const first = await targets.find(ORG);
    expect(members).toHaveBeenCalledTimes(10);
    expect(first).toEqual({ targets: [], next: '11' });
    const rest = await targets.find(ORG, first.next);
    expect(rest.targets.map((m) => m.id)).toEqual(['m12']);
    expect(rest.next).toBeNull();
  });
});
