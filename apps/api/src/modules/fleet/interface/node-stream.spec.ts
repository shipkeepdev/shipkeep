import { create } from '@bufbuild/protobuf';
import {
  type MetricsReport,
  type ActionRequest,
  ActionRequestSchema,
  type ActionUpdate,
  type ConnectRequest,
  ConnectRequestSchema,
  OperationState,
  type StateReport,
} from '@shipkeep/proto-ts';

import type { AgentActions } from '../application/agent-actions';
import { AuthenticateNode } from '../application/authenticate-node';
import type { NodeLiveness } from '../application/node-liveness';
import { LogBatches } from '../application/log-batches';
import { MetricsReports } from '../application/metrics-reports';
import type { StateReports } from '../application/state-reports';
import { NodeStream } from './node-stream';

const idle = { deliverable: () => Promise.resolve([]), record: () => Promise.resolve() };
const queue = (fake: object) => fake as unknown as AgentActions;
const delivered: StateReport[] = [];
const reports = {
  deliver: (_identity: unknown, report: StateReport) => {
    delivered.push(report);
    return Promise.resolve();
  },
} as unknown as StateReports;
const heartbeats: string[] = [];
const hellos: [string, string][] = [];
const liveness = {
  heartbeat: (node: { nodeId: string }) => {
    heartbeats.push(node.nodeId);
    return Promise.resolve();
  },
  hello: (node: { nodeId: string }, agentVersion: string) => {
    hellos.push([node.nodeId, agentVersion]);
    return Promise.resolve();
  },
} as unknown as NodeLiveness;

const identity = { nodeId: 'node', organizationId: 'org', serial: 'serial' };

describe('stream timeouts and failure boundaries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires a silent peer without leaving timers or swallowing stream failures', async () => {
    vi.useFakeTimers();
    const context = new AbortController();
    const authenticate = new AuthenticateNode({
      find: () =>
        Promise.resolve({
          ...identity,
          status: 'enrolling',
          leaseEpoch: 1,
          notBefore: new Date(Date.now() - 1000),
          notAfter: new Date(Date.now() + 60_000),
          revokedAt: null,
        }),
      replace: () => Promise.resolve(false),
    });
    const input: AsyncIterable<ConnectRequest> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
    };
    const stream = new NodeStream(
      authenticate,
      queue(idle),
      liveness,
      reports,
      new MetricsReports(),
      new LogBatches(),
    ).connect(input, context, identity);
    const rejected = expect(stream.next()).rejects.toMatchObject({ code: 4 });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails closed and sanitizes database errors', async () => {
    const context = new AbortController();
    const authenticate = new AuthenticateNode({
      find: () => Promise.reject(new Error('private database detail')),
      replace: () => Promise.resolve(false),
    });
    const input: AsyncIterable<ConnectRequest> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('socket closed')) }),
    };
    await expect(
      new NodeStream(
        authenticate,
        queue(idle),
        liveness,
        reports,
        new MetricsReports(),
        new LogBatches(),
      )
        .connect(input, context, identity)
        .next(),
    ).rejects.toMatchObject({ code: 13, rawMessage: 'agent stream failed' });
  });

  it('delivers unfinished actions once per stream and records agent updates', async () => {
    const context = new AbortController();
    const authenticate = new AuthenticateNode({
      find: () =>
        Promise.resolve({
          ...identity,
          status: 'ready',
          leaseEpoch: 1,
          notBefore: new Date(Date.now() - 1000),
          notAfter: new Date(Date.now() + 60_000),
          revokedAt: null,
        }),
      replace: () => Promise.resolve(false),
    });
    const action = create(ActionRequestSchema, {
      actionId: '019d0000-0000-7000-8000-00000000000a',
      idempotencyKey: 'deploy:1',
    });
    const recorded: ActionUpdate[] = [];
    const fake = {
      deliverable: (_identity: unknown, sent: ReadonlySet<string>) =>
        Promise.resolve<ActionRequest[]>(sent.has(action.actionId) ? [] : [action]),
      record: (_identity: unknown, update: ActionUpdate) => {
        recorded.push(update);
        return Promise.resolve();
      },
    };
    const frames: ConnectRequest[] = [
      create(ConnectRequestSchema, {
        msg: { case: 'hello', value: { nodeId: 'node', leaseEpoch: 1n, agentVersion: 'test' } },
      }),
      create(ConnectRequestSchema, {
        msg: {
          case: 'actionUpdate',
          value: { actionId: action.actionId, state: OperationState.SUCCEEDED },
        },
      }),
      create(ConnectRequestSchema, { msg: { case: 'stateReport', value: { leaseEpoch: 1n } } }),
    ];
    let index = 0;
    const input: AsyncIterable<ConnectRequest> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          index < frames.length
            ? Promise.resolve({ done: false, value: frames[index++] })
            : Promise.resolve({ done: true, value: undefined }),
      }),
    };
    const responses = [];
    for await (const response of new NodeStream(
      authenticate,
      queue(fake),
      liveness,
      reports,
      new MetricsReports(),
      new LogBatches(),
    ).connect(input, context, identity))
      responses.push(response.msg.case);
    expect(responses).toEqual(['welcome', 'actionRequest']);
    expect(recorded.map((update) => update.state)).toEqual([OperationState.SUCCEEDED]);
    expect(delivered.map((report) => report.leaseEpoch)).toEqual([1n]);
    // The hello counts as a heartbeat, and carries the agent's version (ADR 0028).
    expect(hellos).toContainEqual(['node', 'test']);
  });

  /** A stream of the frames given, after a valid hello, for a ready node of epoch 1. */
  async function run(metrics: MetricsReports, frames: ConnectRequest[]): Promise<string[]> {
    const authenticate = new AuthenticateNode({
      find: () =>
        Promise.resolve({
          ...identity,
          status: 'ready',
          leaseEpoch: 1,
          notBefore: new Date(Date.now() - 1000),
          notAfter: new Date(Date.now() + 60_000),
          revokedAt: null,
        }),
      replace: () => Promise.resolve(false),
    });
    const all = [
      create(ConnectRequestSchema, {
        msg: { case: 'hello', value: { nodeId: 'node', leaseEpoch: 1n, agentVersion: 'test' } },
      }),
      ...frames,
    ];
    let index = 0;
    const input: AsyncIterable<ConnectRequest> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          index < all.length
            ? Promise.resolve({ done: false, value: all[index++] })
            : Promise.resolve({ done: true, value: undefined }),
      }),
    };
    const welcome: string[] = [];
    for await (const response of new NodeStream(
      authenticate,
      queue(idle),
      liveness,
      reports,
      metrics,
      new LogBatches(),
    ).connect(input, new AbortController(), identity))
      if (response.msg.case === 'welcome') welcome.push(String(response.msg.value.metrics));
    return welcome;
  }
  const metricsFrame = (leaseEpoch: bigint) =>
    create(ConnectRequestSchema, { msg: { case: 'metricsReport', value: { leaseEpoch } } });

  it('announces metrics only when a store takes them, and hands reports over without waiting', async () => {
    const received: MetricsReport[] = [];
    const metrics = new MetricsReports();
    expect(await run(metrics, [])).toEqual(['false']);
    metrics.register((_identity, report) => {
      received.push(report);
    });
    expect(await run(metrics, [metricsFrame(1n)])).toEqual(['true']);
    expect(received.map((report) => report.leaseEpoch)).toEqual([1n]);
  });

  it('refuses a metrics report it did not announce, or of a stale epoch', async () => {
    await expect(run(new MetricsReports(), [metricsFrame(1n)])).rejects.toMatchObject({ code: 9 });
    const metrics = new MetricsReports();
    metrics.register(() => undefined);
    await expect(run(metrics, [metricsFrame(2n)])).rejects.toMatchObject({ code: 9 });
  });
});
