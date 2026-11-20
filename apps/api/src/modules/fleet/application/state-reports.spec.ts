import { create } from '@bufbuild/protobuf';
import { StateReportSchema } from '@shipkeep/proto-ts';

import { StateReports } from './state-reports';

const identity = { organizationId: 'org', nodeId: 'node', serial: '' };

describe('StateReports', () => {
  it('drops reports nobody registered for', async () => {
    await expect(
      new StateReports().deliver(identity, create(StateReportSchema, {})),
    ).resolves.toBeUndefined();
  });

  it('hands each report to every handler, even after one fails, then reports the failure', async () => {
    const reports = new StateReports();
    const seen: string[] = [];
    reports.register(() => {
      seen.push('deployments');
      return Promise.reject(new Error('database down'));
    });
    reports.register(() => {
      seen.push('apps');
      return Promise.resolve();
    });
    await expect(reports.deliver(identity, create(StateReportSchema, {}))).rejects.toThrow(
      'database down',
    );
    expect(seen).toEqual(['deployments', 'apps']);
  });
});
