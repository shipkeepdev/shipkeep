import type { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import type { ResourceSecurityContext } from '../../identity/application/resource-security-context';
import type { TenantAccess } from '../../organizations/application/tenant-access';
import type { ApplicationStore } from '../../apps/application/ports';

import { MetricsQueries } from './metrics-queries';
import type { MetricsStore, MetricsTargets } from './ports';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-000000000001';
const PROJECT = '0190f5a8-7b1c-7e2d-8f3a-000000000002';
const READ = '0190f5a8-7b1c-7e2d-8f3a-000000000003';
const HIDDEN = '0190f5a8-7b1c-7e2d-8f3a-000000000004';
const USER = '0190f5a8-7b1c-7e2d-8f3a-000000000005';
const context = { userId: USER } as ResourceSecurityContext;
const accounts = {
  run: <T>(_context: unknown, operation: () => Promise<T>) => operation(),
} as unknown as AccountMutationAuthority;
const targets: MetricsTargets = {
  onNode: () => Promise.resolve({ containers: [], hosts: [] }),
  nodeExists: () => Promise.resolve(true),
  environments: () =>
    Promise.resolve([
      { id: READ, projectId: PROJECT },
      { id: HIDDEN, projectId: PROJECT },
    ]),
};
const transaction = { runTenant: <T>(_id: string, work: () => Promise<T>) => work() };

/** Access as the policy would answer it: an admin reads all, a member reads the READ environment. */
function access(role: 'admin' | 'member' | 'outsider'): TenantAccess {
  const allows = (_user: string, permission: string, target: { environmentId?: string }) =>
    Promise.resolve(
      role === 'admin' ||
        (role === 'member' &&
          (permission === 'organization.read' ||
            (permission === 'observability.read' && target.environmentId === READ))),
    );
  return {
    allows,
    require: async (user: string, permission: string, target: { environmentId?: string }) => {
      if (!(await allows(user, permission, target))) throw new Error('not found');
    },
  } as unknown as TenantAccess;
}

function queries(role: 'admin' | 'member' | 'outsider', readable = targets) {
  const sent: string[] = [];
  const store: MetricsStore = {
    write: () => Promise.resolve(),
    queryRange: (query) => {
      sent.push(query);
      return Promise.resolve([]);
    },
    // 1 200 requests that took 6 seconds in all.
    queryInstant: (query) => {
      sent.push(query);
      const value = query.includes('duration') ? 6 : 1200;
      return Promise.resolve([{ labels: {}, points: [[1_795_000_000, value]] }]);
    },
  };
  const service = new MetricsQueries(
    accounts,
    access(role),
    {} as ApplicationStore,
    readable,
    transaction,
    store,
  );
  return { service, sent };
}

describe('MetricsQueries.organization', () => {
  it('reads every environment for an owner or admin', async () => {
    const { service, sent } = queries('admin');
    const answer = await service.organization(context, ORG, '30d');
    // Two series for the chart, two totals over the whole 30 days.
    expect(sent).toHaveLength(4);
    expect(sent.filter((query) => query.includes('[2592000s]'))).toHaveLength(2);
    expect(answer.totalRequests).toBe(1200);
    expect(answer.meanSeconds).toBe(0.005);
    expect(sent.every((query) => !query.includes('environment_id'))).toBe(true);
  });

  it('reads only the environments a member may read', async () => {
    const { service, sent } = queries('member');
    const answer = await service.organization(context, ORG, '24h');
    expect(answer.kept).toBe(true);
    expect(sent).toHaveLength(4);
    expect(sent.every((query) => query.includes(`environment_id=~"${READ}"`))).toBe(true);
    expect(sent.some((query) => query.includes(HIDDEN))).toBe(false);
  });

  it('reads nothing for a member without any readable environment', async () => {
    const { service, sent } = queries('member', {
      ...targets,
      environments: () => Promise.resolve([{ id: HIDDEN, projectId: PROJECT }]),
    });
    const answer = await service.organization(context, ORG, '7d');
    expect(sent).toEqual([]);
    expect(answer.series).toEqual({ requests: [], duration: [] });
    expect(answer.totalRequests).toBe(0);
    expect(answer.meanSeconds).toBeNull();
  });

  it('refuses someone outside the organization', async () => {
    const { service, sent } = queries('outsider');
    await expect(service.organization(context, ORG, '24h')).rejects.toThrow();
    expect(sent).toEqual([]);
  });
});
