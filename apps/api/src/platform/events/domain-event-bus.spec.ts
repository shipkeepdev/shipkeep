import { createEvent, type DomainEvent, SYSTEM_ACTOR } from '@shipkeep/domain';

import { DomainEventBus } from './domain-event-bus';

const event = (type: string): DomainEvent =>
  createEvent({ type, actor: SYSTEM_ACTOR, target: { type: 'node', id: 'n1' }, payload: {} });

describe('DomainEventBus', () => {
  it('delivers events in order to every subscriber', async () => {
    const bus = new DomainEventBus();
    const seen: string[] = [];
    bus.subscribe((e: DomainEvent) => {
      seen.push(`a:${e.type}`);
      return Promise.resolve();
    });
    bus.subscribe((e: DomainEvent) => {
      seen.push(`b:${e.type}`);
      return Promise.resolve();
    });
    await bus.publish([event('node.enrolled'), event('node.removed')]);
    expect(seen).toEqual([
      'a:node.enrolled',
      'b:node.enrolled',
      'a:node.removed',
      'b:node.removed',
    ]);
  });

  it('propagates handler failures to the publisher', async () => {
    const bus = new DomainEventBus();
    bus.subscribe(() => Promise.reject(new Error('audit store down')));
    await expect(bus.publish([event('node.enrolled')])).rejects.toThrow('audit store down');
  });

  it('stops delivering after unsubscribe', async () => {
    const bus = new DomainEventBus();
    let calls = 0;
    const unsubscribe = bus.subscribe(() => {
      calls += 1;
      return Promise.resolve();
    });
    await bus.publish([event('node.enrolled')]);
    unsubscribe();
    await bus.publish([event('node.enrolled')]);
    expect(calls).toBe(1);
    expect(bus.handlerCount).toBe(0);
  });
});
