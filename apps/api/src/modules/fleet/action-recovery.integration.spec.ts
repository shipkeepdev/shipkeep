import { create } from '@bufbuild/protobuf';
import {
  type ActionRequest,
  ActionRequestSchema,
  ActionUpdateSchema,
  OperationState,
} from '@shipkeep/proto-ts';
import { Client } from 'pg';

import { auditLog } from '../../testing/audit-log';
import { enrollTestNode } from '../../testing/enroll-test-node';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { AgentActions } from './application/agent-actions';

function action(init: unknown): ActionRequest['action'] {
  return create(ActionRequestSchema, { action: init as ActionRequest['action'] }).action;
}

/**
 * Issue #484, with PostgreSQL: an action that expired is delivered again for a while, so that an
 * agent holding it unfinished undoes it and says how it ended; the control plane records that end.
 */
describe('recovery of expired actions with PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;
  let actions: AgentActions;
  let nodeId: string;
  let admin: Client;
  const identity = () => ({ organizationId: fixture.organizationId, nodeId, serial: '' });

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
    actions = fixture.app.get(AgentActions);
    nodeId = await enrollTestNode(fixture, {
      facts: {
        hostname: 'edge-recovery-484.example.com',
        architecture: 'amd64',
        cpu_count: 2,
        memory_bytes: 2 ** 32,
      },
    });
    admin = new Client({ connectionString: fixture.databaseUrl });
    await admin.connect();
  });
  afterAll(async () => {
    await admin.end();
    await fixture.close();
  });

  const expiredAction = async (key: string) => {
    const queued = await actions.enqueue({
      organizationId: fixture.organizationId,
      nodeId,
      idempotencyKey: key,
      action: action({ case: 'ensureNetwork', value: { name: 'sk-recovery-484' } }),
      deadline: new Date(Date.now() + 1000),
      actor: { kind: 'system' },
    });
    // Its deadline passes: the next delivery expires it, and delivers it again for recovery.
    const later = new Date(Date.now() + 60_000);
    const delivered = await actions.deliverable(identity(), new Set(), later);
    return { id: queued.id, delivered: delivered.map((request) => request.actionId), later };
  };
  const state = async (id: string) =>
    (
      await admin.query<{ state: string; error: string | null }>(
        'SELECT state, error FROM agent_actions WHERE id = $1',
        [id],
      )
    ).rows[0];

  it('records how the agent undid an expired action, and stops delivering it', async () => {
    const { id, delivered, later } = await expiredAction('recovery:484:undone');
    expect(delivered).toContain(id);
    expect(await state(id)).toEqual({ state: 'expired', error: null });
    // An update while the agent undoes it changes nothing; its final word does.
    await actions.record(
      identity(),
      create(ActionUpdateSchema, { actionId: id, state: OperationState.COMPENSATING }),
    );
    expect(await state(id)).toEqual({ state: 'expired', error: null });
    await actions.record(
      identity(),
      create(ActionUpdateSchema, {
        actionId: id,
        state: OperationState.COMPENSATED,
        error: 'action deadline exceeded',
      }),
    );
    expect(await state(id)).toEqual({ state: 'compensated', error: 'action deadline exceeded' });
    const events = await auditLog().findMany({
      where: { targetId: id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => event.action)).toEqual([
      'fleet.action.queued',
      'fleet.action.expired',
      'fleet.action.compensated',
    ]);
    const after = await actions.deliverable(identity(), new Set(), later);
    expect(after.map((request) => request.actionId)).not.toContain(id);
  });

  it('keeps an action the agent never ran expired, and stops delivering it', async () => {
    const { id, delivered, later } = await expiredAction('recovery:484:never');
    expect(delivered).toContain(id);
    await actions.record(
      identity(),
      create(ActionUpdateSchema, {
        actionId: id,
        state: OperationState.FAILED,
        error: 'action deadline exceeded',
      }),
    );
    expect(await state(id)).toEqual({ state: 'expired', error: 'action deadline exceeded' });
    const after = await actions.deliverable(identity(), new Set(), later);
    expect(after.map((request) => request.actionId)).not.toContain(id);
  });
});
