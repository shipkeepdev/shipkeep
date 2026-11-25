import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ServiceUnavailableException } from '@nestjs/common';
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
    await expect(logs.write([record])).rejects.toBeInstanceOf(ServiceUnavailableException);
    // A store that cannot be reached fails the same way.
    await expect(
      new VictoriaLogsStore('http://127.0.0.1:1').write([record]),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(logs.write([record])).rejects.not.toThrow('/var/lib');
    seen.url = undefined;
    await logs.write([]);
    expect(seen.url).toBeUndefined();
  });
});

describe('reading VictoriaLogs', () => {
  it('sends the query with its limit and reads JSON lines', async () => {
    let seen = '';
    server = createServer((request, response) => {
      seen = request.url ?? '';
      response.end('{"_msg":"a"}\n\n{"_msg":"b"}\n');
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const logs = new VictoriaLogsStore(
      `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    );
    expect(await logs.query('{app="x"} | limit 2', 2)).toEqual([{ _msg: 'a' }, { _msg: 'b' }]);
    expect(seen).toBe('/select/logsql/query?query=%7Bapp%3D%22x%22%7D+%7C+limit+2&limit=2');
  });

  it('answers 503 without the store text, whatever failed', async () => {
    for (const answer of [
      (response: ServerResponse) => {
        response.statusCode = 500;
        response.end('/var/lib/victoria-logs failed');
      },
      (response: ServerResponse) => response.end('not json'),
    ]) {
      server?.close();
      server = createServer((_request, response) => {
        answer(response);
      });
      await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
      const logs = new VictoriaLogsStore(
        `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
      );
      await expect(logs.query('*', 1)).rejects.toMatchObject({ status: 503 });
      await expect(logs.query('*', 1)).rejects.not.toThrow('/var/lib');
    }
  });
});
