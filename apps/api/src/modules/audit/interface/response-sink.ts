import type { Writable } from 'node:stream';

/**
 * What the event pump needs from an HTTP response: whether a write was taken, how many bytes are
 * still queued, and a bounded wait for the queue to empty. Every listener is removed when the wait
 * ends, whichever way it ends.
 */
export function responseSink(response: Writable) {
  return {
    write: (chunk: string): boolean => response.write(chunk),
    pending: (): number => response.writableLength,
    drained: (milliseconds: number, signal: AbortSignal): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        if (!response.writableNeedDrain) {
          resolve(true);
          return;
        }
        if (signal.aborted || response.destroyed) {
          resolve(false);
          return;
        }
        const finish = (value: boolean) => {
          clearTimeout(timer);
          response.off('drain', onDrain);
          response.off('close', onClose);
          signal.removeEventListener('abort', onClose);
          resolve(value);
        };
        const onDrain = () => finish(true);
        const onClose = () => finish(false);
        const timer = setTimeout(onClose, milliseconds);
        response.once('drain', onDrain);
        response.once('close', onClose);
        signal.addEventListener('abort', onClose, { once: true });
      }),
  };
}
