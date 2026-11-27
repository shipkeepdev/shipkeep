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
  buildsOnNode: () => Promise.resolve([]),
  nodeExists: () => Promise.resolve(true),
  deploymentStart: () => Promise.resolve(undefined),
  environments: () =>
    Promise.resolve([
      { id: READ, projectId: PROJECT },
      { id: HIDDEN, projectId: PROJECT },
    ]),
};
const transaction = { runTenant: <T>(_id: string, work: () => Promise<T>) => work() };

/** Access as the policy would answer it: an admin reads all, a member reads the READ environment. */
function access(
  role: 'admin' | 'member' | 'outsider',
  readable: ReadonlySet<string> = new Set([READ]),
): TenantAccess {
  const allows = (_user: string, permission: string, target: { environmentId?: string }) =>
    Promise.resolve(
      role === 'admin' ||
        (role === 'member' &&
          (permission === 'organization.read' ||
            (permission === 'observability.read' &&
              target.environmentId !== undefined &&
              readable.has(target.environmentId)))),
    );
  return {
    allows,
    require: async (user: string, permission: string, target: { environmentId?: string }) => {
      if (!(await allows(user, permission, target))) throw new Error('not found');
    },
  } as unknown as TenantAccess;
}

function queries(
  role: 'admin' | 'member' | 'outsider',
  readable = targets,
  grants?: ReadonlySet<string>,
) {
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
    access(role, grants),
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

  /** An organization of `count` environments, served in identifier order, page by page. */
  const many = (count: number): MetricsTargets => {
    const all = Array.from({ length: count }, (_, index) => ({
      id: `0190f5a8-7b1c-7e2d-8f3a-${String(index).padStart(12, '0')}`,
      projectId: PROJECT,
    }));
    return {
      ...targets,
      environments: (_organization, limit, after) =>
        Promise.resolve(
          all.filter((item) => after === undefined || item.id > after).slice(0, limit),
        ),
    };
  };
  const id = (index: number) => `0190f5a8-7b1c-7e2d-8f3a-${String(index).padStart(12, '0')}`;

  it('finds a readable environment past the first hundred', async () => {
    const { service, sent } = queries('member', many(250), new Set([id(180)]));
    const answer = await service.organization(context, ORG, '24h');
    expect(answer.partial).toBe(false);
    expect(sent.every((query) => query.includes(`environment_id=~"${id(180)}"`))).toBe(true);
    expect(sent).toHaveLength(4);
  });

  it('says the answer is partial past a hundred readable environments', async () => {
    const grants = new Set(Array.from({ length: 120 }, (_, index) => id(index * 2)));
    const { service, sent } = queries('member', many(300), grants);
    const answer = await service.organization(context, ORG, '24h');
    expect(answer.partial).toBe(true);
    const named = sent[0]?.match(/environment_id=~"([^"]*)"/)?.[1]?.split('|') ?? [];
    expect(named).toHaveLength(100);
  });

  it('stops after checking two thousand environments and says so', async () => {
    const { service, sent } = queries('member', many(2500), new Set([id(2400)]));
    const answer = await service.organization(context, ORG, '24h');
    expect(answer.partial).toBe(true);
    expect(sent).toEqual([]);
    expect(answer.totalRequests).toBe(0);
  });

  it('is complete at exactly two thousand environments, partial at one more', async () => {
    const full = queries('member', many(2000), new Set([id(1999)]));
    expect((await full.service.organization(context, ORG, '24h')).partial).toBe(false);
    expect(full.sent.every((query) => query.includes(id(1999)))).toBe(true);
    const over = queries('member', many(2001), new Set([id(1999)]));
    expect((await over.service.organization(context, ORG, '24h')).partial).toBe(true);
  });

  it('is complete for a member who reads every environment of a small organization', async () => {
    const { service } = queries('member', many(3), new Set([id(0), id(1), id(2)]));
    expect((await service.organization(context, ORG, '24h')).partial).toBe(false);
  });
});

// Issue #488: no account lock or transaction is held while the store answers, and access is
// checked again before any series leaves.
describe('MetricsQueries and the account lock', () => {
  /** An authority that counts its runs and says whether a store call happens inside one. */
  function locked() {
    let inside = 0;
    let runs = 0;
    const authority = {
      run: async <T>(_context: unknown, operation: () => Promise<T>) => {
        runs++;
        inside++;
        try {
          return await operation();
        } finally {
          inside--;
        }
      },
    } as unknown as AccountMutationAuthority;
    return { authority, inside: () => inside, runs: () => runs };
  }
  /** A store that records whether it was called inside a run, and runs `during` when it is. */
  function store(lock: ReturnType<typeof locked>, during: () => void = () => undefined) {
    const calls: number[] = [];
    const answer: MetricsStore = {
      write: () => Promise.resolve(),
      queryRange: () => {
        calls.push(lock.inside());
        during();
        return Promise.resolve([]);
      },
      queryInstant: () => {
        calls.push(lock.inside());
        during();
        return Promise.resolve([{ labels: {}, points: [[1_795_000_000, 1]] }]);
      },
    };
    return { answer, calls };
  }
  const application = {
    find: () =>
      Promise.resolve({ id: HIDDEN, organizationId: ORG, projectId: PROJECT, environmentId: READ }),
  } as unknown as ApplicationStore;
  const appTarget = { organizationId: ORG, projectId: PROJECT, environmentId: READ };

  it('reads application, server and organization series outside the lock, then checks again', async () => {
    const lock = locked();
    const metrics = store(lock);
    const service = new MetricsQueries(
      lock.authority,
      access('admin'),
      application,
      targets,
      transaction,
      metrics.answer,
    );
    await service.application(context, appTarget, HIDDEN, '24h');
    await service.node(context, ORG, HIDDEN, '24h');
    await service.organization(context, ORG, '24h');
    expect(metrics.calls.length).toBeGreaterThan(0);
    expect(metrics.calls.every((inside) => inside === 0)).toBe(true);
    // Each answer was authorized twice: before the store, and before it left.
    expect(lock.runs()).toBe(6);
  });

  it('returns nothing when access is lost while the store answers', async () => {
    let allowed = true;
    const lock = locked();
    const metrics = store(lock, () => {
      allowed = false;
    });
    const gate = {
      allows: () => Promise.resolve(allowed),
      require: () => (allowed ? Promise.resolve() : Promise.reject(new Error('not found'))),
    } as unknown as TenantAccess;
    const service = new MetricsQueries(
      lock.authority,
      gate,
      application,
      targets,
      transaction,
      metrics.answer,
    );
    await expect(service.application(context, appTarget, HIDDEN, '24h')).rejects.toThrow();
    allowed = true;
    await expect(service.node(context, ORG, HIDDEN, '24h')).rejects.toThrow();
  });

  it('returns nothing when an environment read becomes unreadable during the read', async () => {
    const grants = new Set([READ, HIDDEN]);
    const lock = locked();
    const metrics = store(lock, () => grants.delete(HIDDEN));
    const service = new MetricsQueries(
      lock.authority,
      access('member', grants),
      application,
      targets,
      transaction,
      metrics.answer,
    );
    await expect(service.organization(context, ORG, '24h')).rejects.toThrow('resource');
  });
});
