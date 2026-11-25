import { TestBed } from '@angular/core/testing';

import { I18n } from '../ui/i18n';

import {
  type ApplicationLogs,
  DeliveryApi,
  type EnvironmentRef,
  type LogLine,
} from './delivery-api';
import { LogsPanel } from './logs-panel';
import { FORWARD_ROUNDS } from './logs-view';

const environment: EnvironmentRef = {
  organizationId: '01900000-0000-7000-8000-000000000001',
  projectId: '01900000-0000-7000-8000-000000000002',
  environmentId: '01900000-0000-7000-8000-00000000000a',
};
const base = Date.parse('2026-11-25T12:00:00.000Z');
const line = (ms: number, stream: 'stdout' | 'stderr' = 'stdout'): LogLine => ({
  time: new Date(base + ms).toISOString(),
  stream,
  instance: 0,
  line: `${stream} ${String(ms)}`,
  truncated: false,
});

type Query = Parameters<DeliveryApi['logs']>[2];

/** The panel's own steps, as its live timer and its buttons call them. */
interface Driven {
  load(asked: boolean): Promise<void>;
  choose(filter: 'all' | 'stdout' | 'stderr'): void;
  lines(): LogLine[];
}

function mount(logs: (query: Query) => Promise<ApplicationLogs>) {
  const asked: Query[] = [];
  TestBed.configureTestingModule({
    imports: [LogsPanel],
    providers: [
      {
        provide: DeliveryApi,
        useValue: {
          logs: (_e: EnvironmentRef, _a: string, query: Query) => {
            asked.push(query);
            return logs(query);
          },
        },
      },
    ],
  });
  TestBed.inject(I18n).use('en');
  const fixture = TestBed.createComponent(LogsPanel);
  fixture.componentRef.setInput('environment', environment);
  fixture.componentRef.setInput('applicationId', '01900000-0000-7000-8000-0000000000a1');
  // Not shown: the test drives the reads itself, instead of the live timer.
  fixture.componentRef.setInput('active', false);
  fixture.detectChanges();
  return { panel: fixture.componentInstance as unknown as Driven, asked };
}

describe('the logs panel', () => {
  it('goes on from where a live read stopped on a full page, not from the newest line again', async () => {
    const { panel, asked } = mount((query) => {
      // The newest line shown is at 10 s; before it, a burst far larger than one tick reads.
      if (!query.from) return Promise.resolve({ kept: true, lines: [line(10_000)] });
      const from = Date.parse(query.from) - base;
      const limit = query.limit ?? 200;
      const lines = Array.from({ length: limit }, (_, i) => line(from + i + 1));
      return Promise.resolve({ kept: true, lines });
    });
    await panel.load(true);
    await panel.load(false);
    const first = asked.slice(1);
    expect(first).toHaveLength(FORWARD_ROUNDS);
    const stopped = first.at(-1)?.from ?? '';
    await panel.load(false);
    // The second tick starts after the lines the first one read, not 3 s before the newest one.
    const second = asked[1 + FORWARD_ROUNDS];
    expect(Date.parse(second.from ?? '')).toBeGreaterThan(Date.parse(stopped));
    expect(second.from).not.toBe(first[0]?.from);
  });

  it('loads afresh after a failed load for another filter, instead of merging old lines in', async () => {
    let failStderr = true;
    const { panel, asked } = mount((query) => {
      if (query.stream === 'stderr') {
        if (failStderr) {
          failStderr = false;
          return Promise.reject(new Error('unavailable'));
        }
        return Promise.resolve({ kept: true, lines: [line(2_000, 'stderr')] });
      }
      return Promise.resolve({ kept: true, lines: [line(1_000), line(500)] });
    });
    await panel.load(true);
    panel.choose('stderr');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The stderr load failed: stdout lines are still shown. The next tick asks for stderr afresh.
    await panel.load(false);
    const tick = asked.at(-1);
    expect(tick?.stream).toBe('stderr');
    expect(tick?.from).toBeUndefined();
    expect(panel.lines().map((l) => l.stream)).toEqual(['stderr']);
  });
});
