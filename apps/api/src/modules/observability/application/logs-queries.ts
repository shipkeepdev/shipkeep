import { Inject, Injectable, Optional } from '@nestjs/common';
import { NotFoundError } from '@shipkeep/domain';

import { APPLICATION_STORE, type ApplicationStore } from '../../apps/application/ports';
import type { ApplicationTarget } from '../../apps/domain/application';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import { type ResourceSecurityContext as SecurityContext } from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import {
  type BuildLine,
  buildLineOf,
  buildLogsQuery,
  distinctBuildLines,
  distinctLines,
  type LogLine,
  logLineOf,
  logsQuery,
} from '../domain/logs';

import {
  LOGS_STORE,
  type LogsStore,
  METRICS_TARGETS,
  METRICS_TRANSACTION,
  type MetricsTargets,
  type MetricsTransaction,
} from './ports';

export interface LogsAnswer {
  /** False when no log store is configured: no line is kept. */
  readonly kept: boolean;
  /** In the order the search asked: newest first by default. */
  readonly lines: readonly LogLine[];
}

/** How far behind the control plane an agent's clock may be when the build output is read. */
const CLOCK_MARGIN_MS = 3_600_000;

/** Searches an application's logs (ADR 0029), for a person who may read its environment. */
@Injectable()
export class LogsQueries {
  constructor(
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    @Inject(APPLICATION_STORE) private readonly applications: ApplicationStore,
    @Inject(METRICS_TRANSACTION) private readonly transaction: MetricsTransaction,
    @Optional() @Inject(LOGS_STORE) private readonly store: LogsStore | null,
    @Inject(METRICS_TARGETS) private readonly targets: MetricsTargets,
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

  /**
   * One deployment's build output (ADR 0032), oldest first from `from`, or from the start of the
   * deployment. Authorized as a search, with the deployment checked to be the application's.
   */
  async buildOutput(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    deploymentId: string,
    search: { from?: Date | undefined; fromExact?: string | undefined; to: Date; limit: number },
  ): Promise<{ kept: boolean; lines: BuildLine[] }> {
    const scope = {
      organizationId: target.organizationId,
      projectId: target.projectId,
      environmentId: target.environmentId,
    };
    const authorize = () =>
      this.accounts.run(
        context,
        async () => {
          await this.access.require(context.userId, 'environment.read', scope);
          return this.transaction.runTenant(target.organizationId, async () => {
            const found = await this.applications.find(target, applicationId);
            if (!found) throw new NotFoundError('application');
            const started = await this.targets.deploymentStart(found.id, deploymentId);
            if (!started) throw new NotFoundError('deployment');
            return { application: found, started };
          });
        },
        { permission: 'environment.read', target: scope },
      );
    const { application, started } = await authorize();
    const store = this.store;
    if (!store) return { kept: false, lines: [] };
    // Read with no lock or transaction held, then authorized again before any line leaves (#488).
    const records = await store.query(
      buildLogsQuery({
        organizationId: target.organizationId,
        applicationId: application.id,
        deploymentId,
        // The agent stamps the lines with its own clock, so an hour before the start keeps them
        // all; the deployment label alone selects them.
        from: search.from ?? new Date(started.getTime() - CLOCK_MARGIN_MS),
        fromExact: search.fromExact,
        to: search.to,
        limit: search.limit,
      }),
      search.limit,
    );
    await authorize();
    return {
      kept: true,
      lines: distinctBuildLines(records.map(buildLineOf).filter((line) => line !== undefined)),
    };
  }
}
