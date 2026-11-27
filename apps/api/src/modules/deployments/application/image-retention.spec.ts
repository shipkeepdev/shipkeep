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
const at = (minute: number) => new Date(Date.UTC(2026, 10, 27, 12, minute));
const image = (tag: number) => `cp.example.com/${ORG}/${APP}:${String(tag)}`;

function world(
  options: { catalogPage?: number; failingTag?: string; failingAudit?: boolean } = {},
) {
  const repositories = [
    `${ORG}/${APP}`,
    `${ORG}/${GONE}`,
    `${ORG}/${FAILING}`,
    'library/nginx',
    `${ORG}/not-an-id`,
  ];
  const tags = new Map<string, string[]>([
    // Release 9's build failed after it pushed; `latest` is a tag no release runs.
    [`${ORG}/${APP}`, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'latest']],
    [`${ORG}/${GONE}`, ['1']],
    [`${ORG}/${FAILING}`, ['1']],
    ['library/nginx', ['1']],
  ]);
  const deleted: string[] = [];
  const catalogCalls: (string | undefined)[] = [];
  const registry: RegistryStorage = {
    // Pages shorter than asked for, as a registry may answer before the end.
    repositories: (last, limit) => {
      catalogCalls.push(last);
      const from = last === undefined ? 0 : repositories.indexOf(last) + 1;
      return Promise.resolve(
        repositories.slice(from, from + Math.min(limit, options.catalogPage ?? limit)),
      );
    },
    tags: (repository) => {
      if (repository.endsWith(FAILING)) return Promise.reject(new Error('internal detail'));
      return Promise.resolve([...(tags.get(repository) ?? [])]);
    },
    deleteTag: (repository, tag) => {
      if (tag === options.failingTag) return Promise.reject(new Error('internal detail'));
      deleted.push(`${repository}:${tag}`);
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
                  image: image(index + 1),
                  deployments: [{ state: 'succeeded', finishedAt: at(index) }],
                })),
                {
                  number: 9,
                  image: image(9),
                  deployments: [{ state: 'failed', finishedAt: at(20) }],
                },
                // A rollback to release 2 made release 10, which runs release 2's image.
                {
                  number: 10,
                  image: image(2),
                  deployments: [{ state: 'succeeded', finishedAt: at(25) }],
                },
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
  };
  const events: DomainEvent[] = [];
  const bus = {
    publish: (batch: DomainEvent[]) => {
      if (options.failingAudit) return Promise.reject(new Error('audit store down'));
      events.push(...batch);
      return Promise.resolve();
    },
  } as unknown as DomainEventBus;
  return {
    retention: new ImageRetention(registry, store, transaction, bus),
    deleted,
    events,
    tenants,
    catalogCalls,
  };
}

describe('image retention runs (ADR 0030)', () => {
  it('removes the tags no kept release runs, keeps the one a rollback runs, and audits it', async () => {
    const { retention, deleted, events } = world();
    const result = await retention.run(at(30));
    // Releases 10 (release 2's image) and 4 to 8 are the six last deployed with success; release
    // 9 failed, release 3 is the seventh, and no release runs tag 10 or `latest`.
    expect(deleted.filter((entry) => entry.startsWith(`${ORG}/${APP}:`)).sort()).toEqual(
      ['1', '10', '3', '9', 'latest'].map((tag) => `${ORG}/${APP}:${tag}`),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'application.images_pruned',
      organizationId: ORG,
      target: { type: 'application', id: APP },
      payload: { applicationId: APP, tags: '1,10,3,9,latest', count: 5 },
    });
    expect(result).toEqual({ repositories: 5, deleted: 6 });
  });

  it('empties the repository of an application that no longer exists, without an audit event', async () => {
    const { retention, deleted, events } = world();
    await retention.run(at(30));
    expect(deleted).toContain(`${ORG}/${GONE}:1`);
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

  it('goes on after a tag it cannot remove, and audits the others', async () => {
    const { retention, deleted, events } = world({ failingTag: '3' });
    await retention.run(at(30));
    expect(deleted).not.toContain(`${ORG}/${APP}:3`);
    expect(deleted).toContain(`${ORG}/${APP}:9`);
    expect(events[0]?.payload).toMatchObject({ tags: '1,10,9,latest', count: 4 });
  });

  it('removes the tags even when the audit cannot be written, and goes on', async () => {
    const { retention, deleted } = world({ failingAudit: true });
    const result = await retention.run(at(30));
    expect(deleted).toContain(`${ORG}/${APP}:1`);
    expect(deleted).toContain(`${ORG}/${GONE}:1`);
    expect(result.repositories).toBe(5);
  });

  it('reads the catalog past short pages, to the empty one', async () => {
    const { retention, deleted, catalogCalls } = world({ catalogPage: 2 });
    const result = await retention.run(at(30));
    expect(result.repositories).toBe(5);
    expect(deleted).toContain(`${ORG}/${GONE}:1`);
    expect(catalogCalls).toEqual([
      undefined,
      `${ORG}/${GONE}`,
      'library/nginx',
      `${ORG}/not-an-id`,
    ]);
  });
});
