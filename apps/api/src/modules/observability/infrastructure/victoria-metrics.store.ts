import type { MetricsStore, Series } from '../application/ports';

/** Answers larger than this are not read: the queries of a chart return a few series. */
const MAX_ANSWER = 4 << 20;
const TIMEOUT_MS = 5000;

/**
 * VictoriaMetrics over its HTTP API (ADR 0024), on the control plane's internal network. Its
 * error text never reaches a caller: only the status does.
 */
export class VictoriaMetricsStore implements MetricsStore {
  constructor(private readonly base: string) {}

  async write(exposition: string): Promise<void> {
    if (!exposition) return;
    const response = await fetch(new URL('/api/v1/import/prometheus', this.base), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: exposition,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`metrics store refused a write (${String(response.status)})`);
  }

  async queryRange(query: string, start: Date, end: Date, stepSeconds: number): Promise<Series[]> {
    const url = new URL('/api/v1/query_range', this.base);
    url.searchParams.set('query', query);
    url.searchParams.set('start', String(Math.floor(start.getTime() / 1000)));
    url.searchParams.set('end', String(Math.floor(end.getTime() / 1000)));
    url.searchParams.set('step', `${String(stepSeconds)}s`);
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await response.text();
    if (!response.ok || text.length > MAX_ANSWER)
      throw new Error(`metrics store answered ${String(response.status)}`);
    return parseMatrix(JSON.parse(text) as unknown);
  }
}

/** The `matrix` result of a range query, with every value checked; anything else is empty. */
export function parseMatrix(answer: unknown): Series[] {
  if (!isRecord(answer) || answer['status'] !== 'success' || !isRecord(answer['data'])) return [];
  const data = answer['data'];
  if (data['resultType'] !== 'matrix' || !Array.isArray(data['result'])) return [];
  const series: Series[] = [];
  for (const item of data['result'] as unknown[]) {
    if (!isRecord(item) || !isRecord(item['metric']) || !Array.isArray(item['values'])) continue;
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(item['metric']))
      if (typeof value === 'string') labels[key] = value;
    const points: [number, number][] = [];
    for (const pair of item['values'] as unknown[]) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const [time, value] = pair as [unknown, unknown];
      const number = typeof value === 'string' ? Number(value) : Number.NaN;
      if (typeof time === 'number' && Number.isFinite(time) && Number.isFinite(number))
        points.push([time, number]);
    }
    series.push({ labels, points });
  }
  return series;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
