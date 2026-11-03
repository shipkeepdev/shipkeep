import { createEvent, SYSTEM_ACTOR } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import type { AuditRecord } from '../domain/audit-record';

import type { AuditEventStore } from './audit-event-store';
import { AuditRecorder } from './audit-recorder';

class MemoryStore implements AuditEventStore {
  readonly records: AuditRecord[] = [];
  append(record: AuditRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }
}

describe('AuditRecorder', () => {
  it('appends one record per published event with a UUIDv7 id', async () => {
    const bus = new DomainEventBus();
    const store = new MemoryStore();
    const recorder = new AuditRecorder(bus, store);
    recorder.onModuleInit();

    await bus.publish([
      createEvent({
        type: 'node.enrolled',
        actor: SYSTEM_ACTOR,
        target: { type: 'node', id: 'n1' },
        payload: {},
      }),
      createEvent({
        type: 'node.removed',
        actor: SYSTEM_ACTOR,
        target: { type: 'node', id: 'n1' },
        payload: {},
      }),
    ]);

    expect(store.records.map((r) => r.action)).toEqual(['node.enrolled', 'node.removed']);
    for (const record of store.records) {
      expect(record.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(store.records[0]?.id.localeCompare(store.records[1]?.id ?? '')).toBeLessThan(0);

    recorder.onModuleDestroy();
    await bus.publish([
      createEvent({
        type: 'node.enrolled',
        actor: SYSTEM_ACTOR,
        target: { type: 'node', id: 'n2' },
        payload: {},
      }),
    ]);
    expect(store.records).toHaveLength(2);
  });

  it('fails the publish when the store rejects', async () => {
    const bus = new DomainEventBus();
    const recorder = new AuditRecorder(bus, {
      append: () => Promise.reject(new Error('disk full')),
    });
    recorder.onModuleInit();
    await expect(
      bus.publish([
        createEvent({
          type: 'node.enrolled',
          actor: SYSTEM_ACTOR,
          target: { type: 'node', id: 'n1' },
          payload: {},
        }),
      ]),
    ).rejects.toThrow('disk full');
  });
});
