import { createEvent } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../platform/events/domain-event-bus';
import { PrismaUnitOfWork } from '../../platform/prisma/prisma-unit-of-work';
import { auditLog } from '../../testing/audit-log';
import { tenantHttpFixture } from '../../testing/tenant-http';

import {
  type ExecSession,
  ExecSessionRegistry,
  execSessionInterrupted,
} from './application/exec-relay';
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
  // The follow-up of #489: the closing is decided under the session's lock, so checks that run at
  // once (the start's sweep and the worker, or two processes) and an end record one closing.
  const check = (sessionId: string) => ({
    organizationId: fixture.organizationId,
    sessionId,
    userId: fixture.actors.owner.id,
  });
  const session = (): ExecSession => {
    const now = Date.now();
    return {
      id: uuidv7(),
      organizationId: fixture.organizationId,
      projectId: uuidv7(),
      environmentId: uuidv7(),
      applicationId: uuidv7(),
      userId: fixture.actors.owner.id,
      nodeId: uuidv7(),
      container: 'sk-web-r1-0',
      tty: true,
      attachBy: new Date(now + 60_000),
      endsAt: new Date(now + 30 * 60_000),
    };
  };

  it('records one closing when checks of a session race', async () => {
    const checks = fixture.app.get(ExecSessionChecks);
    const sessionId = uuidv7();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => checks.check(check(sessionId))),
    );
    expect(outcomes.filter((outcome) => outcome === 'interrupted')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'closed')).toHaveLength(7);
    expect(await closings(sessionId)).toEqual(['exec.session.interrupted']);
  });

  it("records one closing when a session's end and another process's check race", async () => {
    const registry = fixture.app.get(ExecSessionRegistry);
    const s = session();
    registry.add(s);
    registry.joinAgent(s.id, s)?.agentLeft();
    // Another process's check does not see this registry: it decides from the database alone.
    const checked = fixture.app
      .get(PrismaUnitOfWork)
      .runTenant(s.organizationId, () => registry.closeOnce(s, execSessionInterrupted(s)));
    await Promise.all([checked, registry.settle(10_000)]);
    expect(registry.ending(s.id)).toBe(false);
    const recorded = await closings(s.id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0] === 'exec.session.ended').toBe(!(await checked));
  });

  it('looks again later at a session whose end this process is still writing', async () => {
    const registry = fixture.app.get(ExecSessionRegistry);
    const s = session();
    registry.add(s);
    registry.joinAgent(s.id, s)?.agentLeft();
    expect(await fixture.app.get(ExecSessionChecks).check(check(s.id))).toBe('live');
    await registry.settle(10_000);
    expect(await closings(s.id)).toEqual(['exec.session.ended']);
  });
});
