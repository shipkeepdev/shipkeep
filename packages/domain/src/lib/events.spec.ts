import { createEvent, SYSTEM_ACTOR } from './events.js';

describe('createEvent', () => {
  it('builds a well-formed event', () => {
    const before = Date.now();
    const event = createEvent({
      type: 'organization.created',
      actor: { kind: 'user', id: 'usr_1', ip: '203.0.113.5' },
      target: { type: 'organization', id: 'org_1' },
      organizationId: 'org_1',
      payload: { slug: 'acme' },
    });
    expect(event.type).toBe('organization.created');
    expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(event.payload).toEqual({ slug: 'acme' });
  });

  it('omits organizationId for installation-wide events', () => {
    const event = createEvent({
      type: 'control_plane.upgraded',
      actor: SYSTEM_ACTOR,
      target: { type: 'control_plane', id: 'self' },
      payload: {},
    });
    expect('organizationId' in event).toBe(false);
  });

  it.each(['Created', 'organization', 'organization.', '.created', 'org anization.created'])(
    'rejects the type %p',
    (type) => {
      expect(() =>
        createEvent({ type, actor: SYSTEM_ACTOR, target: { type: 'x', id: '1' }, payload: {} }),
      ).toThrow(TypeError);
    },
  );

  it('rejects empty targets', () => {
    expect(() =>
      createEvent({ type: 'a.b', actor: SYSTEM_ACTOR, target: { type: '', id: '1' }, payload: {} }),
    ).toThrow(/empty target/);
  });
});
