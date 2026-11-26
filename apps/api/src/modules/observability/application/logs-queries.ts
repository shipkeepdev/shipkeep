import { Inject, Injectable, Optional } from '@nestjs/common';
import { NotFoundError } from '@shipkeep/domain';

import { APPLICATION_STORE, type ApplicationStore } from '../../apps/application/ports';
import type { ApplicationTarget } from '../../apps/domain/application';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import { type ResourceSecurityContext as SecurityContext } from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import { distinctLines, type LogLine, logLineOf, logsQuery } from '../domain/logs';

import { LOGS_STORE, type LogsStore, METRICS_TRANSACTION, type MetricsTransaction } from './ports';

export interface LogsAnswer {
  /** False when no log store is configured: no line is kept. */
  readonly kept: boolean;
  /** In the order the search asked: newest first by default. */
  readonly lines: readonly LogLine[];
}

/** Searches an application's logs (ADR 0029), for a person who may read its environment. */
@Injectable()
export class LogsQueries {
  constructor(
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    @Inject(APPLICATION_STORE) private readonly applications: ApplicationStore,
    @Inject(METRICS_TRANSACTION) private readonly transaction: MetricsTransaction,
    @Optional() @Inject(LOGS_STORE) private readonly store: LogsStore | null,
  ) {}

  async search(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    search: {
      text: string;
      stream?: 'stdout' | 'stderr' | undefined;
      instance?: number | undefined;
      from: Date;
      fromExact?: string | undefined;
      to: Date;
      limit: number;
      order?: 'newest' | 'oldest' | undefined;
    },
  ): Promise<LogsAnswer> {
    const scope = {
      organizationId: target.organizationId,
      projectId: target.projectId,
      environmentId: target.environmentId,
    };
    // Authorized in a short transaction, read with neither a lock nor a transaction held, then
    // authorized again before any line leaves: a slow store never holds the account's lock, and
    // access lost during the read returns nothing (issue #488).
    const authorize = () =>
      this.accounts.run(
        context,
        async () => {
          await this.access.require(context.userId, 'environment.read', scope);
          const found = await this.transaction.runTenant(target.organizationId, () =>
            this.applications.find(target, applicationId),
          );
          if (!found) throw new NotFoundError('application');
          return found;
        },
        { permission: 'environment.read', target: scope },
      );
    const found = await authorize();
    const store = this.store;
    if (!store) return { kept: false, lines: [] };
    // A failure of the store is a 503 whose text never names the store's (the store says so).
    const records = await store.query(
      logsQuery({ organizationId: target.organizationId, applicationId: found.id, ...search }),
      search.limit,
    );
    await authorize();
    const lines = distinctLines(records.map(logLineOf).filter((line) => line !== undefined));
    return { kept: true, lines };
  }
}
