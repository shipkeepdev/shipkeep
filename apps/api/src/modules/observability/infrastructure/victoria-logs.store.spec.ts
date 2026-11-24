import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { VictoriaLogsStore } from './victoria-logs.store';

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function store(
  status: number,
): Promise<{ store: VictoriaLogsStore; seen: { url?: string; body?: string } }> {
  const seen: { url?: string; body?: string } = {};
  server = createServer((request: IncomingMessage, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      seen.url = request.url;
      seen.body = body;
      response.statusCode = status;
      response.end('internal detail /var/lib/victoria');
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { store: new VictoriaLogsStore(`http://127.0.0.1:${String(port)}`), seen };
}

const record = {
  _time: '2026-11-24T12:00:00.000Z',
  _msg: 'hello "world"\n',
  org: 'o',
  project: 'p',
  env: 'e',
  app: 'a',
  instance: '1',
  node: 'n',
  stream: 'stdout' as const,
};

describe('the VictoriaLogs store', () => {
  it('writes JSON lines with the stream, time and message fields', async () => {
    const { store: logs, seen } = await store(204);
    await logs.write([record, { ...record, _msg: 'second' }]);
    expect(seen.url).toBe(
      '/insert/jsonline?_stream_fields=org%2Capp%2Cinstance%2Cstream&_time_field=_time&_msg_field=_msg',
    );
    expect(seen.body?.split('\n').map((line) => JSON.parse(line) as unknown)).toEqual([
      record,
      { ...record, _msg: 'second' },
    ]);
  });

  it('fails without the store text, and writes nothing for no records', async () => {
    const { store: logs, seen } = await store(500);
    await expect(logs.write([record])).rejects.toThrow('log store answered 500');
    await expect(logs.write([record])).rejects.not.toThrow('/var/lib');
    seen.url = undefined;
    await logs.write([]);
    expect(seen.url).toBeUndefined();
  });
});
