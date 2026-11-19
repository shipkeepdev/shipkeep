import { createServer, type ServerResponse } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';

import type { AuditRecord } from '../domain/audit-record';
import { MAX_PENDING_BYTES, type PumpEnd, pumpEvents } from '../application/environment-events';

import { responseSink } from './response-sink';

const event = (index: number): AuditRecord =>
  ({
    id: `0192f0c0-0000-7000-8000-${String(index).padStart(12, '0')}`,
    action: 'deployment.advanced',
    targetType: 'deployment',
    targetId: 'x'.repeat(200),
    metadata: {},
    createdAt: new Date('2026-11-19T12:00:00Z'),
  }) as unknown as AuditRecord;

/**
 * A real HTTP server whose handler runs the pump on its response, with polls that always return
 * a full batch, and a raw TCP client that sends the request and then reads or not.
 */
async function stream(read: boolean, abortAfter?: number) {
  let resolveEnd: (value: { end: PumpEnd; pending: number; destroyed: boolean }) => void;
  const ended = new Promise<{ end: PumpEnd; pending: number; destroyed: boolean }>((resolve) => {
    resolveEnd = resolve;
  });
  let polls = 0;
  const controller = new AbortController();
  const server = createServer((request, response: ServerResponse) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    void pumpEvents({
      after: 'start',
      poll: () => {
        polls++;
        if (abortAfter !== undefined && polls >= abortAfter) controller.abort();
        return Promise.resolve(
          Array.from({ length: 100 }, (_, index) => event(polls * 100 + index)),
        );
      },
      ...responseSink(response),
      signal: controller.signal,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
      now: () => 0,
    }).then((end) => {
      const pending = response.writableLength;
      if (end === 'slow') response.destroy();
      else response.end();
      resolveEnd({ end, pending, destroyed: response.destroyed });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const client: Socket = connect({ port, host: '127.0.0.1' });
  let received = 0;
  let closed = false;
  client.on('data', (chunk: Buffer) => {
    received += chunk.length;
  });
  client.on('close', () => {
    closed = true;
  });
  if (!read) client.pause();
  client.write(`GET / HTTP/1.1\r\nHost: test\r\nAccept: text/event-stream\r\n\r\n`);
  // Bounded: a pump that never stops (one that ignores backpressure) fails here instead of hanging.
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    ended,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`the stream did not end: ${polls} polls`));
      }, 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
  await new Promise((resolve) => setTimeout(resolve, 50));
  client.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { ...result, polls, received, closed };
}

describe('responseSink on a real HTTP response (#345)', () => {
  it('stops reading and drops the connection when the client stops reading', async () => {
    const result = await stream(false);
    expect(result.end).toBe('slow');
    // What stays queued in the process is bounded by the budget, plus one event.
    expect(result.pending).toBeLessThanOrEqual(MAX_PENDING_BYTES + 512);
    expect(result.destroyed).toBe(true);
    // The kernel buffers are finite: the pump stopped polling after a bounded number of batches.
    expect(result.polls).toBeLessThan(2000);
  }, 30_000);

  it('keeps delivering to a client that reads', async () => {
    const result = await stream(true, 20);
    expect(result.end).toBe('done');
    expect(result.polls).toBe(20);
    expect(result.received).toBeGreaterThan(100_000);
  }, 30_000);
});
