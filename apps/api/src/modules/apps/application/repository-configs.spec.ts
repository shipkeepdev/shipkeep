import type { DomainEvent } from '@shipkeep/domain';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { DomainEventBus } from '../../../platform/events/domain-event-bus';
import type { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import type { TenantAccess } from '../../organizations/application/tenant-access';

import type {
  ApplicationStore,
  ApplicationTransaction,
  RepositorySource,
  WrittenConfigChange,
} from './ports';
import { RepositoryConfigs } from './repository-configs';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const TEXT = 'version: 1\nname: web\nbuild:\n  type: dockerfile\nrun:\n  port: 3000\n';
const BLOB = 'b'.repeat(40);
const target = {
  organizationId: ORG,
  projectId: '0190f5a8-7b1c-7e2d-8f3a-0000000000bb',
  environmentId: '0190f5a8-7b1c-7e2d-8f3a-0000000000cc',
};

/** The world of one Git application; `moved` is the file's blob when the branch moved on. */
function world(
  options: { auditFails?: boolean; moved?: string; earlier?: WrittenConfigChange } = {},
) {
  const writes: { changeId: string; text: string }[] = [];
  const published: DomainEvent[] = [];
  const application = {
    id: '0190f5a8-7b1c-7e2d-8f3a-0000000000dd',
    organizationId: ORG,
    projectId: target.projectId,
    environmentId: target.environmentId,
    name: 'web',
    repository: {
      installationId: 1,
      repositoryId: 2,
      fullName: 'acme-corp/web',
      branch: 'main',
      configPath: 'shipkeep.yml',
      commitSha: 'a'.repeat(40),
    },
  };
  const store = {
    find: () => Promise.resolve(application),
    writeMode: () => Promise.resolve('pull_request' as const),
  } as unknown as ApplicationStore;
  const repositories = {
    readForChange: () =>
      Promise.resolve({
        fullName: 'acme-corp/web',
        commitSha: 'a'.repeat(40),
        text: TEXT,
        blobSha: options.moved ?? BLOB,
      }),
    writeConfig: (_org: string, _location: unknown, change: { changeId: string; text: string }) => {
      writes.push({ changeId: change.changeId, text: change.text });
      return Promise.resolve({
        via: 'pull_request' as const,
        commitSha: 'c'.repeat(40),
        url: 'https://github.com/acme-corp/web/pull/3',
        number: 3,
        branch: 'shipkeep/config-0123456789abcdef',
      });
    },
    writtenChange: () => Promise.resolve(options.earlier),
  } as unknown as RepositorySource;
  const transaction = {
    runTenant: (_org: string, work: () => Promise<unknown>) => work(),
  } as unknown as ApplicationTransaction;
  const accounts = {
    run: (_context: unknown, work: () => Promise<unknown>) => work(),
  } as unknown as AccountMutationAuthority;
  const access = { require: () => Promise.resolve() } as unknown as TenantAccess;
  const events = {
    publish: (batch: DomainEvent[]) => {
      if (options.auditFails) return Promise.reject(new Error('audit store down: internal detail'));
      published.push(...batch);
      return Promise.resolve();
    },
  } as unknown as DomainEventBus;
  return {
    configs: new RepositoryConfigs(
      store,
      transaction,
      accounts,
      access,
      'cp.example.com',
      repositories,
      events,
    ),
    writes,
    published,
  };
}

const APPLICATION = '0190f5a8-7b1c-7e2d-8f3a-0000000000dd';
const context = {
  userId: '0190f5a8-7b1c-7e2d-8f3a-0000000000ee',
  securityVersion: 1,
  kind: 'session',
} as never;
const document = (replicas = 2) => ({
  version: 1,
  name: 'web',
  build: { type: 'dockerfile' },
  run: { port: 3000 },
  scale: { replicas },
});

describe('a change written to its repository, audited (#214)', () => {
  it('fails when the audit fails after the write, saying the change was written', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { configs, writes } = world({ auditFails: true });
      // As any command whose audit fails; sent again, it is found where it was written.
      await expect(
        configs.change(context, target, APPLICATION, document(), BLOB),
      ).rejects.toMatchObject({ kind: 'unavailable', code: 'config_written_unrecorded' });
      expect(writes).toHaveLength(1);
      expect(error).toHaveBeenCalledTimes(1);
      const [logged] = error.mock.calls[0] ?? [];
      expect(logged).toMatchObject({
        action: 'application.config_written',
        applicationId: APPLICATION,
        payload: {
          via: 'pull_request',
          pullRequest: 3,
          url: 'https://github.com/acme-corp/web/pull/3',
        },
      });
      // The store's error stays out of the log: it may hold details.
      expect(JSON.stringify(error.mock.calls)).not.toContain('internal detail');
    } finally {
      error.mockRestore();
    }
  });

  it('names a change after what it asks for, so that sending it again finds it', async () => {
    const { configs, writes } = world();
    await configs.change(context, target, APPLICATION, document(), BLOB);
    await configs.change(context, target, APPLICATION, document(), BLOB);
    await configs.change(context, target, APPLICATION, document(3), BLOB);
    const [first, again, other] = writes.map((write) => write.changeId);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });

  it('takes up the commit an earlier attempt made when the branch moved on by it', async () => {
    const earlier = {
      via: 'commit' as const,
      commitSha: 'e'.repeat(40),
      url: `https://github.com/acme-corp/web/commit/${'e'.repeat(40)}`,
    };
    const { configs, writes, published } = world({ moved: 'f'.repeat(40), earlier });
    expect(await configs.change(context, target, APPLICATION, document(), BLOB)).toEqual(earlier);
    expect(writes).toEqual([]);
    expect(published).toHaveLength(1);
    expect(published[0]?.payload).toMatchObject({ via: 'commit', commitSha: 'e'.repeat(40) });
    // It was made against a commit the branch has moved on from.
    expect(published[0]?.payload).not.toHaveProperty('fromCommit');
  });

  it('refuses a change whose file moved on by anything else', async () => {
    const { configs, writes, published } = world({ moved: 'f'.repeat(40) });
    await expect(
      configs.change(context, target, APPLICATION, document(), BLOB),
    ).rejects.toMatchObject({ code: 'config_file_changed' });
    expect(writes).toEqual([]);
    expect(published).toEqual([]);
  });
});
