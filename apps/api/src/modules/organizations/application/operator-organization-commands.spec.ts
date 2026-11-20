import { ConflictError } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';

import { OperatorOrganizationCommands } from './operator-organization-commands';
import type { OrganizationRecord, OrganizationStore } from './organization-store';

const ID = '0190f5a8-7b1c-7e2d-8f3a-000000000001';
const now = new Date('2026-11-20T12:00:00Z');
const record = (slug: string): OrganizationRecord => ({
  id: ID,
  name: 'Atelier Sud',
  slug,
  createdAt: now,
  updatedAt: now,
});

/** A store whose insert loses to a concurrent call: nothing was there, then the winner's row is. */
function racing(winner: OrganizationRecord | undefined): {
  store: OrganizationStore;
  reads: () => number;
} {
  let reads = 0;
  const store: OrganizationStore = {
    transaction: (_id, operation) => operation(),
    create: () =>
      Promise.reject(
        new ConflictError('organization_slug_unavailable', 'Organization slug is unavailable.'),
      ),
    ownedBy: () => Promise.resolve(reads++ === 0 ? undefined : winner),
    update: () => Promise.reject(new Error('not used')),
  };
  return { store, reads: () => reads };
}

describe('OperatorOrganizationCommands with an id chosen by the installer', () => {
  const create = (store: OrganizationStore) =>
    new OperatorOrganizationCommands(store, new DomainEventBus()).create(
      { name: 'Atelier Sud', slug: 'atelier-sud' },
      'owner-1',
      now,
      ID,
    );

  it('returns the organization a concurrent call committed first', async () => {
    const { store, reads } = racing(record('atelier-sud'));
    await expect(create(store)).resolves.toEqual(record('atelier-sud'));
    expect(reads()).toBe(2);
  });

  it('refuses it when the concurrent call used another slug', async () => {
    const { store } = racing(record('atelier-ouest'));
    await expect(create(store)).rejects.toMatchObject({ code: 'organization_id_taken' });
  });

  it('keeps the refusal of the insert when no organization of this owner has the id', async () => {
    const { store } = racing(undefined);
    await expect(create(store)).rejects.toMatchObject({ code: 'organization_slug_unavailable' });
  });
});
