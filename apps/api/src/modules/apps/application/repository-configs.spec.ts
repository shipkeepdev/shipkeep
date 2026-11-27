import type { DomainEvent } from '@shipkeep/domain';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { DomainEventBus } from '../../../platform/events/domain-event-bus';
import type { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import type { TenantAccess } from '../../organizations/application/tenant-access';

import type { ApplicationStore, ApplicationTransaction, RepositorySource } from './ports';
import { RepositoryConfigs } from './repository-configs';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const TEXT = 'version: 1\nname: web\nbuild:\n  type: dockerfile\nrun:\n  port: 3000\n';
const BLOB = 'b'.repeat(40);
const target = {
  organizationId: ORG,
  projectId: '0190f5a8-7b1c-7e2d-8f3a-0000000000bb',
  environmentId: '0190f5a8-7b1c-7e2d-8f3a-0000000000cc',
};

/** The world of one Git application whose audit store fails. */
function world() {
  const writes: string[] = [];
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
        blobSha: BLOB,
      }),
    writeConfig: (_org: string, _location: unknown, change: { text: string }) => {
      writes.push(change.text);
      return Promise.resolve({
        via: 'pull_request' as const,
        commitSha: 'c'.repeat(40),
        url: 'https://github.com/acme-corp/web/pull/3',
        number: 3,
        branch: 'shipkeep/config-0123456789ab',
      });
    },
  } as unknown as RepositorySource;
  const transaction = {
    runTenant: (_org: string, work: () => Promise<unknown>) => work(),
  } as unknown as ApplicationTransaction;
  const accounts = {
    run: (_context: unknown, work: () => Promise<unknown>) => work(),
  } as unknown as AccountMutationAuthority;
  const access = { require: () => Promise.resolve() } as unknown as TenantAccess;
  const events = {
    publish: (_batch: DomainEvent[]) =>
      Promise.reject(new Error('audit store down: internal detail')),
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
  };
}

describe('a change written to its repository, audited (#214)', () => {
  it('answers the change written even when the audit fails, and the log keeps the event', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { configs, writes } = world();
      const document = {
        version: 1,
        name: 'web',
        build: { type: 'dockerfile' },
        run: { port: 3000 },
        scale: { replicas: 2 },
      };
      const context = {
        userId: '0190f5a8-7b1c-7e2d-8f3a-0000000000ee',
        securityVersion: 1,
        kind: 'session',
      };
      const written = await configs.change(
        context as never,
        target,
        '0190f5a8-7b1c-7e2d-8f3a-0000000000dd',
        document,
        BLOB,
      );
      // GitHub has it: failing would only make the caller write it a second time.
      expect(written).toMatchObject({ via: 'pull_request', number: 3 });
      expect(writes).toHaveLength(1);
      expect(error).toHaveBeenCalledTimes(1);
      const [logged] = error.mock.calls[0] ?? [];
      expect(logged).toMatchObject({
        action: 'application.config_written',
        applicationId: '0190f5a8-7b1c-7e2d-8f3a-0000000000dd',
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
});
