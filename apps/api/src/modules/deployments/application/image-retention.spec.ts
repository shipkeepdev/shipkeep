import type { DomainEvent } from '@shipkeep/domain';
import { describe, expect, it } from 'vitest';

import type { DomainEventBus } from '../../../platform/events/domain-event-bus';
import type { RegistryStorage } from '../../registries/application/ports';

import { ImageRetention } from './image-retention';
import type { DeploymentTransaction, RetentionStore } from './ports';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const APP = '0190f5a8-7b1c-7e2d-8f3a-0000000000ab';
const GONE = '0190f5a8-7b1c-7e2d-8f3a-0000000000ac';
const FAILING = '0190f5a8-7b1c-7e2d-8f3a-0000000000ad';
const digest = (n: number) => `sha256:${String(n).padStart(64, '0')}`;
const at = (minute: number) => new Date(Date.UTC(2026, 10, 27, 12, minute));

function world() {
  const repositories = [
    `${ORG}/${APP}`,
    `${ORG}/${GONE}`,
    `${ORG}/${FAILING}`,
    'library/nginx',
    `${ORG}/not-an-id`,
  ];
  const tags = new Map<string, Map<string, string>>([
    [
      `${ORG}/${APP}`,
      new Map([
        ...Array.from({ length: 8 }, (_, index) => [String(index + 1), digest(index + 1)] as const),
        // Release 9's build failed after it pushed; `latest` names release 8's manifest.
        ['9', digest(9)],
        ['latest', digest(8)],
      ]),
    ],
    [`${ORG}/${GONE}`, new Map([['1', digest(21)]])],
    [`${ORG}/${FAILING}`, new Map([['1', digest(31)]])],
    ['library/nginx', new Map([['1', digest(41)]])],
  ]);
  const deleted: string[] = [];
  const registry: RegistryStorage = {
    repositories: (last, limit) => {
      const from = last === undefined ? 0 : repositories.indexOf(last) + 1;
      return Promise.resolve(repositories.slice(from, from + limit));
    },
    tags: (repository) => {
      if (repository.endsWith(FAILING)) return Promise.reject(new Error('internal detail'));
      return Promise.resolve([...(tags.get(repository)?.keys() ?? [])]);
    },
    digest: (repository, tag) => Promise.resolve(tags.get(repository)?.get(tag)),
    deleteManifest: (repository, removed) => {
      deleted.push(`${repository}@${removed}`);
      return Promise.resolve(true);
    },
  };
  const store: RetentionStore = {
    releases: (applicationId) =>
      Promise.resolve(
        applicationId === APP
          ? {
              projectId: 'project',
              environmentId: 'environment',
              releases: [
                ...Array.from({ length: 8 }, (_, index) => ({
                  number: index + 1,
                  deployments: [{ state: 'succeeded', finishedAt: at(index) }],
                })),
                { number: 9, deployments: [{ state: 'failed', finishedAt: at(20) }] },
              ],
            }
          : undefined,
      ),
  };
  const tenants: string[] = [];
  const transaction: DeploymentTransaction = {
    runTenant: (organizationId, work) => {
      tenants.push(organizationId);
      return work();
    },
  } as DeploymentTransaction;
  const events: DomainEvent[] = [];
  const bus = {
    publish: (batch: DomainEvent[]) => {
      events.push(...batch);
      return Promise.resolve();
    },
  } as unknown as DomainEventBus;
  return {
    retention: new ImageRetention(registry, store, transaction, bus),
    deleted,
    events,
    tenants,
  };
}

describe('image retention runs (ADR 0030)', () => {
  it('removes what no rollback reaches, keeps a manifest a kept tag names, and audits it', async () => {
    const { retention, deleted, events } = world();
    const result = await retention.run(at(30));
    // Releases 3 to 8 are the six last deployed with success; release 9 failed.
    expect(deleted.filter((entry) => entry.startsWith(`${ORG}/${APP}@`)).sort()).toEqual(
      [digest(1), digest(2), digest(9)].map((removed) => `${ORG}/${APP}@${removed}`),
    );
    expect(deleted).not.toContain(`${ORG}/${APP}@${digest(8)}`);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'application.images_pruned',
      organizationId: ORG,
      target: { type: 'application', id: APP },
      payload: { applicationId: APP, tags: '1,2,9', count: 3 },
    });
    expect(result).toEqual({ repositories: 5, deleted: 4 });
  });

  it('empties the repository of an application that no longer exists, without an audit event', async () => {
    const { retention, deleted, events } = world();
    await retention.run(at(30));
    expect(deleted).toContain(`${ORG}/${GONE}@${digest(21)}`);
    expect(events.every((event) => event.target.id !== GONE)).toBe(true);
  });

  it("leaves the registry's other repositories alone, and goes on after one that fails", async () => {
    const { retention, deleted, tenants } = world();
    await retention.run(at(30));
    expect(
      deleted.some((entry) => entry.startsWith('library/') || entry.includes('not-an-id')),
    ).toBe(false);
    expect(deleted.some((entry) => entry.includes(FAILING))).toBe(false);
    // Each application's releases are read in its own organization's tenant scope.
    expect(new Set(tenants)).toEqual(new Set([ORG]));
  });
});
