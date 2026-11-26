import { createEvent } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';

import { ExecSessionChecks } from './infrastructure/exec-session-checks';

/**
 * Issue #489, with PostgreSQL and pg-boss: a session whose end was never recorded is recorded
 * interrupted by its check, once; a session whose end was recorded is left as it is.
 */
describe('exec session checks with PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof tenantHttpFixture>>;

  beforeAll(async () => {
    fixture = await tenantHttpFixture();
  });
  afterAll(async () => {
    await fixture.close();
  });

  const closings = async (sessionId: string) =>
    (
      await auditLog().findMany({
        where: { targetType: 'exec_session', targetId: sessionId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((event) => event.action);

  it('records interrupted, once, the session of a stopped process', async () => {
    const checks = fixture.app.get(ExecSessionChecks);
    const sessionId = uuidv7();
    // Queued with the opening; its process then stopped before the session ended.
    await checks.schedule({
      id: sessionId,
      organizationId: fixture.organizationId,
      userId: fixture.actors.owner.id,
      endsAt: new Date(Date.now() + 30 * 60_000),
    });
    // The next process runs the checks it finds at start, without waiting for their time.
    expect(await checks.sweep()).toBe(1);
    expect(await closings(sessionId)).toEqual(['exec.session.interrupted']);
    // Its job, when it comes, finds the closing recorded.
    expect(
      await checks.check({
        organizationId: fixture.organizationId,
        sessionId,
        userId: fixture.actors.owner.id,
      }),
    ).toBe('closed');
    expect(await closings(sessionId)).toEqual(['exec.session.interrupted']);
  });

  it('leaves a session whose end was recorded', async () => {
    const checks = fixture.app.get(ExecSessionChecks);
    const sessionId = uuidv7();
    await fixture.app.get(PrismaUnitOfWork).runTenant(fixture.organizationId, () =>
      fixture.app.get(DomainEventBus).publish([
        createEvent({
          type: 'exec.session.ended',
          organizationId: fixture.organizationId,
          actor: { kind: 'user', id: fixture.actors.owner.id },
          target: { type: 'exec_session', id: sessionId },
          payload: { reason: 'exited', exitCode: 0, durationMs: 1000 },
        }),
      ]),
    );
    expect(
      await checks.check({
        organizationId: fixture.organizationId,
        sessionId,
        userId: fixture.actors.owner.id,
      }),
    ).toBe('closed');
    expect(await closings(sessionId)).toEqual(['exec.session.ended']);
  });
});
