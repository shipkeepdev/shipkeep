import type { ConnectRequest } from '@shipkeep/proto-ts';

import { AuthenticateNode } from '../application/authenticate-node';
import { NodeStream } from './node-stream';

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
    const stream = new NodeStream(authenticate).connect(input, context, identity);
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
      new NodeStream(authenticate).connect(input, context, identity).next(),
    ).rejects.toMatchObject({ code: 13, rawMessage: 'agent stream failed' });
  });
});
