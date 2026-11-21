import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { MetricsReportSchema } from '@shipkeep/proto-ts';

import { MetricsReports } from '../../fleet/application/metrics-reports';

import { MetricsIngest } from './metrics-ingest';
import type { MetricsStore, MetricsTargets } from './ports';

const identity = {
  organizationId: '0190f5a8-7b1c-7e2d-8f3a-000000000001',
  nodeId: '0190f5a8-7b1c-7e2d-8f3a-000000000002',
  serial: '',
};
const targets: MetricsTargets = {
  onNode: () => Promise.resolve({ containers: [], hosts: [] }),
  nodeExists: () => Promise.resolve(true),
  environments: () => Promise.resolve([]),
};
const transaction = { runTenant: <T>(_id: string, work: () => Promise<T>) => work() };
const report = (sampledAt?: Date) =>
  create(MetricsReportSchema, {
    leaseEpoch: 1n,
    sampledAt: sampledAt && timestampFromDate(sampledAt),
    node: { cpuSeconds: 1, cpuCores: 2, memoryUsedBytes: 1n, memoryTotalBytes: 2n },
  });

describe('MetricsIngest', () => {
  it('registers with the stream only when a metrics store is configured', () => {
    const without = new MetricsReports();
    new MetricsIngest(without, targets, transaction, null).onModuleInit();
    expect(without.accepting).toBe(false);
    const withStore = new MetricsReports();
    const store: MetricsStore = {
      write: () => Promise.resolve(),
      queryRange: () => Promise.resolve([]),
      queryInstant: () => Promise.resolve([]),
    };
    new MetricsIngest(withStore, targets, transaction, store).onModuleInit();
    expect(withStore.accepting).toBe(true);
  });

  it('drops reports past eight writes under way, without waiting for the store', () => {
    let writes = 0;
    const store: MetricsStore = {
      write: () => {
        writes++;
        return new Promise(() => undefined);
      },
      queryRange: () => Promise.resolve([]),
      queryInstant: () => Promise.resolve([]),
    };
    const ingest = new MetricsIngest(new MetricsReports(), targets, transaction, store);
    for (let index = 0; index < 20; index++) ingest.accept(identity, report());
    return new Promise<void>((done) => {
      setTimeout(() => {
        expect(writes).toBe(8);
        done();
      }, 20);
    });
  });

  it('writes nothing for an invalid report, and keeps a sample time only near its own clock', async () => {
    const written: string[] = [];
    const store: MetricsStore = {
      write: (text) => {
        written.push(text);
        return Promise.resolve();
      },
      queryRange: () => Promise.resolve([]),
      queryInstant: () => Promise.resolve([]),
    };
    const ingest = new MetricsIngest(new MetricsReports(), targets, transaction, store);
    const now = new Date('2026-11-20T12:00:00Z');
    await ingest.record(
      identity,
      create(MetricsReportSchema, { containers: [{ name: '../etc', cpuSeconds: 1 }] }),
      now,
    );
    expect(written).toEqual([]);
    await ingest.record(identity, report(new Date(now.getTime() - 20_000)), now);
    await ingest.record(identity, report(new Date('2030-01-01T00:00:00Z')), now);
    const times = written.map((text) => text.trim().split('\n')[0]?.split(' ').at(-1));
    expect(times).toEqual([String(now.getTime() - 20_000), String(now.getTime())]);
  });
});
