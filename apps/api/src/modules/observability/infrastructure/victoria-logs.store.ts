import { ServiceUnavailableException } from '@nestjs/common';

import type { LogsStore } from '../application/ports';
import type { LogRecord } from '../domain/logs';

const TIMEOUT_MS = 10_000;
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
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException('Logs temporarily unavailable.');
}
