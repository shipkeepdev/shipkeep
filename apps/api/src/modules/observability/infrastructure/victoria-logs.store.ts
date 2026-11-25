import { ServiceUnavailableException } from '@nestjs/common';

import type { LogsStore } from '../application/ports';
import type { LogRecord } from '../domain/logs';

import { discard, readBounded } from './bounded-read';

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
    await discard(response);
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
      await discard(response);
      throw unavailable();
    }
    const text = await readBounded(response, MAX_ANSWER, unavailable);
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

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException('Logs temporarily unavailable.');
}
