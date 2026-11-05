import { ServiceUnavailableException } from '@nestjs/common';

import { BoundedConcurrency } from './bounded-concurrency';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('BoundedConcurrency', () => {
  it('runs at most `active` operations at once and queues the rest', async () => {
    const limit = new BoundedConcurrency(2, 5, 'busy');
    const gates = [deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;
    const runs = gates.map((gate) =>
      limit.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await gate.promise;
        running--;
      }),
    );
    await flush();
    expect(running).toBe(2);
    gates[0]?.resolve();
    await flush();
    expect(running).toBe(2);
    gates[1]?.resolve();
    gates[2]?.resolve();
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it('fails fast with 503 once the queue is full', async () => {
    const limit = new BoundedConcurrency(1, 1, 'busy');
    const gate = deferred();
    const first = limit.run(() => gate.promise);
    const second = limit.run(() => Promise.resolve());
    await expect(limit.run(() => Promise.resolve())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    gate.resolve();
    await Promise.all([first, second]);
  });

  it('releases the slot when an operation fails', async () => {
    const limit = new BoundedConcurrency(1, 0, 'busy');
    await expect(limit.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limit.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
