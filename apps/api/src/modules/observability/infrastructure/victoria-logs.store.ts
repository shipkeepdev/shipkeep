import { ServiceUnavailableException } from '@nestjs/common';

import type { LogsStore } from '../application/ports';
import type { LogRecord } from '../domain/logs';

const TIMEOUT_MS = 10_000;
/** Answers larger than this are not read: 500 lines of 16 KiB with their labels fit in it. */
const MAX_ANSWER = 16 << 20;
/** The fields that make a log stream in VictoriaLogs: one per replica and output stream. */
const STREAM_FIELDS = 'org,app,instance,stream';

/** VictoriaLogs over its HTTP API (ADR 0029), on the control plane's internal network. */
export class VictoriaLogsStore implements LogsStore {
  constructor(private readonly base: string) {}

  async write(records: readonly LogRecord[]): Promise<void> {
    if (records.length === 0) return;
    const url = new URL('/insert/jsonline', this.base);
    url.searchParams.set('_stream_fields', STREAM_FIELDS);
    url.searchParams.set('_time_field', '_time');
    url.searchParams.set('_msg_field', '_msg');
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/stream+json' },
        body: records.map((record) => JSON.stringify(record)).join('\n'),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw unavailable();
    }
    await response.body?.cancel();
    // The store's text never travels: the caller only learns that the batch was not kept.
    if (!response.ok) throw unavailable();
  }

  async query(logsql: string, limit: number): Promise<unknown[]> {
    const url = new URL('/select/logsql/query', this.base);
    url.searchParams.set('query', logsql);
    url.searchParams.set('limit', String(limit));
    // What a caller learns of any failure of the store: its text and status stay private.
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => {
      throw unavailable();
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable();
    }
    const text = await readLimited(response, MAX_ANSWER);
    try {
      return text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as unknown);
    } catch {
      throw unavailable();
    }
  }
}

/** The body of a response, read up to max bytes: past them reading stops and the answer fails. */
async function readLimited(response: Response, max: number): Promise<string> {
  // Node's fetch types its body loosely: it is a stream of bytes.
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw unavailable();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException('Logs temporarily unavailable.');
}
