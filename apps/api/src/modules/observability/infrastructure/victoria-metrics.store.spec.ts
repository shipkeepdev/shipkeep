import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ServiceUnavailableException } from '@nestjs/common';

import { parseMatrix, VictoriaMetricsStore } from './victoria-metrics.store';

describe('parseMatrix', () => {
  it('reads the series of a range query and skips any point it cannot read', () => {
    expect(
      parseMatrix({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { status: '2xx' },
              values: [
                [1795000000, '1.5'],
                [1795000030, 'NaN'],
                ['x', '2'],
              ],
            },
          ],
        },
      }),
    ).toEqual([{ labels: { status: '2xx' }, points: [[1795000000, 1.5]] }]);
    expect(
      parseMatrix({
        status: 'success',
        data: { resultType: 'vector', result: [{ metric: {}, value: [1795000000, '1200'] }] },
      }),
    ).toEqual([{ labels: {}, points: [[1795000000, 1200]] }]);
    expect(parseMatrix({ status: 'error' })).toEqual([]);
    expect(parseMatrix('<html>')).toEqual([]);
  });
});

describe('VictoriaMetricsStore', () => {
  let server: Server;
  let answer: (response: ServerResponse) => void;
  let base: string;
  /** Bytes the server managed to send before the client stopped reading. */
  let sent = 0;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      answer(response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  const query = () =>
    new VictoriaMetricsStore(base).queryRange('up', new Date(0), new Date(60_000), 30);

  it("turns a refusal into a 503 that keeps the store's text private", async () => {
    answer = (response) => {
      response.writeHead(503).end('private store detail');
    };
    const error = await query().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).not.toContain('private');
    await expect(new VictoriaMetricsStore(base).write('x 1 1\n')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('stops reading an answer past its bound, before the whole body arrives', async () => {
    sent = 0;
    const chunk = Buffer.alloc(1 << 20, 'x');
    answer = (response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      const pump = () => {
        while (sent < 64 << 20) {
          sent += chunk.length;
          if (!response.write(chunk)) {
            response.once('drain', pump);
            return;
          }
        }
        response.end();
      };
      response.on('close', () => response.removeAllListeners('drain'));
      pump();
    };
    await expect(query()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sent).toBeLessThan(64 << 20);
  });

  it('is unavailable when it cannot be reached', async () => {
    await expect(
      new VictoriaMetricsStore('http://127.0.0.1:1').queryRange('up', new Date(0), new Date(1), 30),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
