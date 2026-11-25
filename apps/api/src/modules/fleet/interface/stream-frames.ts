import { Code, ConnectError } from '@connectrpc/connect';

/** What waitForFrame gives when no frame came within its poll interval. */
export const tick = Symbol('tick');

/**
 * The next frame of an agent stream, or `tick` after `pollMs` without one, so that a stream checks
 * the node's credential even while its peer stays silent. An abort of `signal` rejects with its
 * reason when that is a ConnectError.
 */
export function waitForFrame<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  pollMs: number,
): Promise<T | typeof tick> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(
        signal.reason instanceof ConnectError
          ? signal.reason
          : new ConnectError('agent stream cancelled', Code.Canceled),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(tick);
    }, pollMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(
          error instanceof Error ? error : new ConnectError('invalid stream input', Code.Internal),
        );
      },
    );
  });
}

export function nextFrame<T>(reader: AsyncIterator<T>): Promise<IteratorResult<T>> {
  const pending = reader.next();
  // A socket may close while the database check is pending. Observe rejection immediately;
  // waitForFrame still propagates it unless this stream has already been cancelled.
  void pending.catch(() => undefined);
  return pending;
}
