import { Inject, Injectable, Optional } from '@nestjs/common';
import { NotFoundError } from '@shipkeep/domain';

import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import { type ResourceSecurityContext as SecurityContext } from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import { APPLICATION_STORE, type ApplicationStore } from '../../apps/application/ports';
import type { ApplicationTarget } from '../../apps/domain/application';
import { applicationQueries, nodeQueries, type Range, RANGES } from '../domain/metrics';

import {
  METRICS_STORE,
  METRICS_TARGETS,
  METRICS_TRANSACTION,
  type MetricsStore,
  type MetricsTargets,
  type MetricsTransaction,
  type Series,
} from './ports';

/** What a chart reads: each named query's series over the period, or nothing when no store is kept. */
export interface MetricsAnswer<K extends string> {
  readonly kept: boolean;
  readonly range: Range;
  readonly stepSeconds: number;
  readonly from: Date;
  readonly to: Date;
  readonly series: Readonly<Record<K, readonly Series[]>>;
}

/**
 * Reads metrics back (ADR 0024): an application's with `environment.read`, a server's with
 * `node.manage`. The query is built from identifiers checked here, for the caller's organization,
 * after the application or the server was found in it.
 */
@Injectable()
export class MetricsQueries {
  constructor(
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    @Inject(APPLICATION_STORE) private readonly applications: ApplicationStore,
    @Inject(METRICS_TARGETS) private readonly targets: MetricsTargets,
    @Inject(METRICS_TRANSACTION) private readonly transaction: MetricsTransaction,
    @Optional() @Inject(METRICS_STORE) private readonly store: MetricsStore | null,
  ) {}

  application(
    context: SecurityContext,
    target: ApplicationTarget,
    applicationId: string,
    range: Range,
    now = new Date(),
  ): Promise<MetricsAnswer<'cpu' | 'memory' | 'requests' | 'duration'>> {
    const scope = {
      organizationId: target.organizationId,
      projectId: target.projectId,
      environmentId: target.environmentId,
    };
    return this.accounts.run(
      context,
      async () => {
        await this.access.require(context.userId, 'environment.read', scope);
        const found = await this.transaction.runTenant(target.organizationId, () =>
          this.applications.find(target, applicationId),
        );
        if (!found) throw new NotFoundError('application');
        return this.answer(applicationQueries(target.organizationId, found.id, range), range, now);
      },
      { permission: 'environment.read', target: scope },
    );
  }

  node(
    context: SecurityContext,
    organizationId: string,
    nodeId: string,
    range: Range,
    now = new Date(),
  ): Promise<
    MetricsAnswer<'cpu' | 'memory' | 'memoryTotal' | 'disk' | 'diskTotal' | 'received' | 'sent'>
  > {
    return this.accounts.run(context, async () => {
      await this.access.require(context.userId, 'node.manage', { organizationId });
      const exists = await this.transaction.runTenant(organizationId, () =>
        this.targets.nodeExists(organizationId, nodeId),
      );
      if (!exists) throw new NotFoundError('resource');
      return this.answer(nodeQueries(organizationId, nodeId, range), range, now);
    });
  }

  private async answer<K extends string>(
    queries: Readonly<Record<K, string>>,
    range: Range,
    now: Date,
  ): Promise<MetricsAnswer<K>> {
    const { seconds, step } = RANGES[range];
    const from = new Date(now.getTime() - seconds * 1000);
    const names = Object.keys(queries) as K[];
    const store = this.store;
    const results = store
      ? await Promise.all(names.map((name) => store.queryRange(queries[name], from, now, step)))
      : names.map(() => []);
    const series = {} as Record<K, readonly Series[]>;
    names.forEach((name, index) => {
      series[name] = results[index] ?? [];
    });
    return {
      kept: store !== null,
      range,
      stepSeconds: step,
      from,
      to: now,
      series,
    };
  }
}
