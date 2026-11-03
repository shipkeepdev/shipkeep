import { createEvent, SYSTEM_ACTOR } from '@shipkeep/domain';

import { auditRecordFromEvent } from './audit-record';

describe('auditRecordFromEvent', () => {
  it('copies every audited field and nulls the optional ones', () => {
    const at = new Date('2026-11-03T10:00:00Z');
    const record = auditRecordFromEvent(
      createEvent({
        type: 'node.enrolled',
        actor: SYSTEM_ACTOR,
        target: { type: 'node', id: 'node_1' },
        payload: { name: 'edge-1' },
        occurredAt: at,
      }),
      '0192f0c0-0000-7000-8000-000000000001',
    );
    expect(record).toEqual({
      id: '0192f0c0-0000-7000-8000-000000000001',
      organizationId: null,
      actorKind: 'system',
      actorId: null,
      ip: null,
      action: 'node.enrolled',
      targetType: 'node',
      targetId: 'node_1',
      metadata: { name: 'edge-1' },
      createdAt: at,
    });
  });

  it('keeps tenant and actor details when present', () => {
    const record = auditRecordFromEvent(
      createEvent({
        type: 'secret.set',
        actor: { kind: 'user', id: 'usr_1', ip: '198.51.100.7' },
        target: { type: 'secret', id: 'sec_1' },
        organizationId: 'org_1',
        payload: { name: 'DATABASE_URL', version: 3 },
      }),
      'id',
    );
    expect(record.organizationId).toBe('org_1');
    expect(record.actorId).toBe('usr_1');
    expect(record.ip).toBe('198.51.100.7');
    expect(record.metadata).toEqual({ name: 'DATABASE_URL', version: 3 });
  });
});
