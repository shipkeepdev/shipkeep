import { NotFoundError } from '@shipkeep/domain';
import { describe, expect, it } from 'vitest';

import type { ApplicationStore } from '../../apps/application/ports';
import type { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import type { ResourceSecurityContext } from '../../identity/application/resource-security-context';
import type { TenantAccess } from '../../organizations/application/tenant-access';

import { LogsQueries } from './logs-queries';
import type { LogsStore, MetricsTransaction } from './ports';

const target = {
  organizationId: '019d0000-0000-7000-8000-00000000000a',
  projectId: '019d0000-0000-7000-8000-00000000000b',
  environmentId: '019d0000-0000-7000-8000-00000000000c',
};
const APP = '019d0000-0000-7000-8000-0000000000a1';
const context = { userId: 'u', ip: '203.0.113.7' } as ResourceSecurityContext;
const search = {
  text: 'x',
  from: new Date('2026-11-24T11:00:00Z'),
  to: new Date('2026-11-24T12:00:00Z'),
  limit: 10,
};

function service(options: { store?: LogsStore | null; app?: boolean; denied?: boolean } = {}) {
  return new LogsQueries(
    {
      run: (_c: unknown, work: () => Promise<unknown>) => work(),
    } as unknown as AccountMutationAuthority,
    {
      require: () =>
        options.denied ? Promise.reject(new NotFoundError('resource')) : Promise.resolve(),
    } as unknown as TenantAccess,
    {
      find: () => Promise.resolve(options.app === false ? undefined : { id: APP, ...target }),
    } as unknown as ApplicationStore,
    { runTenant: (_o: string, work: () => Promise<unknown>) => work() } as MetricsTransaction,
    options.store === undefined ? null : options.store,
  );
}

describe('log searches', () => {
  it('reads the application lines, and drops what Shipkeep did not write', async () => {
    const asked: string[] = [];
    const store: LogsStore = {
      write: () => Promise.resolve(),
      query: (logsql) => {
        asked.push(logsql);
        return Promise.resolve([
          { _time: '2026-11-24T11:30:00Z', _msg: 'x happened', stream: 'stdout', instance: '1' },
          { foreign: true },
        ]);
      },
    };
    const answer = await service({ store }).search(context, target, APP, search);
    expect(answer).toEqual({
      kept: true,
      lines: [
        {
          time: '2026-11-24T11:30:00.000000000Z',
          stream: 'stdout',
          instance: 1,
          line: 'x happened',
          truncated: false,
        },
      ],
    });
    expect(asked[0]).toContain(`app="${APP}"`);
  });

  it('says no logs are kept without a store, and refuses an unknown application or no permission', async () => {
    expect(await service().search(context, target, APP, search)).toEqual({
      kept: false,
      lines: [],
    });
    await expect(
      service({ app: false }).search(context, target, APP, search),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service({ denied: true }).search(context, target, APP, search),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // Issue #488: the account's lock and transaction are never held while the store answers, and
  // access is checked again before any line leaves.
  it('reads the store outside the account lock, and authorizes again before answering', async () => {
    let inside = 0;
    let runs = 0;
    const reads: number[] = [];
    let allowed = true;
    let revoke = true;
    const queries = new LogsQueries(
      {
        run: async (_c: unknown, work: () => Promise<unknown>) => {
          runs++;
          inside++;
          try {
            return await work();
          } finally {
            inside--;
          }
        },
      } as unknown as AccountMutationAuthority,
      {
        require: () =>
          allowed ? Promise.resolve() : Promise.reject(new NotFoundError('resource')),
      } as unknown as TenantAccess,
      { find: () => Promise.resolve({ id: APP, ...target }) } as unknown as ApplicationStore,
      { runTenant: (_o: string, work: () => Promise<unknown>) => work() } as MetricsTransaction,
      {
        write: () => Promise.resolve(),
        query: () => {
          reads.push(inside);
          // Access is withdrawn while the store answers, the first time.
          if (revoke) allowed = false;
          return Promise.resolve([
            { _time: '2026-11-24T11:30:00Z', _msg: 'x happened', stream: 'stdout', instance: '1' },
          ]);
        },
      },
    );
    await expect(queries.search(context, target, APP, search)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(reads).toEqual([0]);
    expect(runs).toBe(2);
    allowed = true;
    revoke = false;
    const answer = await queries.search(context, target, APP, search);
    // Allowed throughout? Then the lines come back: the second check passes.
    expect(answer.kept).toBe(true);
  });
});
