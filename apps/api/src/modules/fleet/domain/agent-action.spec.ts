import { summarizeAction } from './agent-action';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const CONTAINER = 'f'.repeat(64);

describe('summarizeAction', () => {
  it('reports unfinished actions as in progress, without a result', () => {
    for (const state of ['queued', 'pending', 'running', 'compensating'] as const)
      expect(summarizeAction({ state, error: null, result: { containerId: CONTAINER } })).toEqual({
        outcome: 'in_progress',
        reason: null,
        result: null,
      });
  });

  it('maps the agent refusals to stable reasons (SPEC 3.4)', () => {
    const refusals = {
      'malformed action request': 'malformed_request',
      'action not supported by this agent': 'unsupported_action',
      'stale lease epoch': 'stale_lease_epoch',
      'invalid action input': 'invalid_input',
      'idempotency key reused for a different action': 'idempotency_conflict',
    } as const;
    for (const [error, reason] of Object.entries(refusals))
      expect(summarizeAction({ state: 'failed', error, result: null })).toEqual({
        outcome: 'refused',
        reason,
        result: null,
      });
  });

  it('keeps execution failures apart from refusals', () => {
    expect(
      summarizeAction({ state: 'failed', error: 'action deadline exceeded', result: null }),
    ).toEqual({ outcome: 'failed', reason: 'deadline_exceeded', result: null });
    expect(summarizeAction({ state: 'failed', error: 'action failed', result: null })).toEqual({
      outcome: 'failed',
      reason: 'action_failed',
      result: null,
    });
    // The journal reports a failed operation without a message.
    expect(summarizeAction({ state: 'failed', error: null, result: null })).toEqual({
      outcome: 'failed',
      reason: 'action_failed',
      result: null,
    });
  });

  it('never echoes an unknown error text', () => {
    const leaked = 'pull failed: password=hunter2 for registry.example.com';
    const summary = summarizeAction({ state: 'failed', error: leaked, result: null });
    expect(summary).toEqual({ outcome: 'failed', reason: 'unknown', result: null });
    expect(JSON.stringify(summary)).not.toContain('hunter2');
    for (const error of ['constructor', '__proto__', 'toString', ''])
      expect(summarizeAction({ state: 'failed', error, result: null }).reason).toBe('unknown');
  });

  it('reports actions that expired on the control plane, were cancelled or compensated', () => {
    expect(summarizeAction({ state: 'expired', error: null, result: null }).outcome).toBe(
      'expired',
    );
    expect(summarizeAction({ state: 'cancelled', error: null, result: null }).outcome).toBe(
      'cancelled',
    );
    expect(summarizeAction({ state: 'compensated', error: null, result: null }).outcome).toBe(
      'compensated',
    );
  });

  it('summarizes typed results with their safe fields only', () => {
    const succeeded = (result: unknown) =>
      summarizeAction({ state: 'succeeded', error: null, result }).result;
    expect(succeeded({ containerId: CONTAINER })).toEqual({
      type: 'container',
      containerId: CONTAINER,
    });
    expect(succeeded({ imageDigest: DIGEST })).toEqual({ type: 'image', imageDigest: DIGEST });
    expect(succeeded({ buildImage: { imageDigest: DIGEST, sizeBytes: '10' } })).toEqual({
      type: 'image',
      imageDigest: DIGEST,
    });
    expect(
      succeeded({ healthCheck: { healthy: true, lastError: 'GET /health?token=secret' } }),
    ).toEqual({ type: 'health_check', healthy: true });
    // Protobuf JSON omits default values: an unhealthy result and exit code 0 are empty.
    expect(succeeded({ healthCheck: {} })).toEqual({ type: 'health_check', healthy: false });
    expect(succeeded({ releaseTask: { outputTail: 'DATABASE_URL=postgres://u:p@db' } })).toEqual({
      type: 'release_task',
      exitCode: 0,
    });
    expect(succeeded({ releaseTask: { exitCode: 3 } })).toEqual({
      type: 'release_task',
      exitCode: 3,
    });
    expect(succeeded({ transfer: { sha256: 'b'.repeat(64) } })).toEqual({ type: 'transfer' });
    expect(succeeded({ facts: { hostname: 'edge-1' } })).toEqual({ type: 'facts' });
    expect(succeeded(null)).toBeNull();
  });

  it('drops malformed or hostile result values', () => {
    const succeeded = (result: unknown) =>
      summarizeAction({ state: 'succeeded', error: null, result }).result;
    for (const bad of [
      { containerId: '../../etc/passwd' },
      { containerId: `${CONTAINER}<script>` },
      { containerId: 'f'.repeat(65) },
      { imageDigest: 'sha256:short' },
      { imageDigest: `registry.example.com/app@${DIGEST}` },
      { buildImage: { imageDigest: 42 } },
      { releaseTask: { exitCode: 1.5 } },
      { releaseTask: { exitCode: 2 ** 40 } },
      { healthCheck: { healthy: 'yes' } },
      { unknownResult: {} },
      'containerId',
      [CONTAINER],
    ])
      expect(succeeded(bad)).toBeNull();
  });
});
