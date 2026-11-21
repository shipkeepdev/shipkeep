import { Inject, Injectable, Optional } from '@nestjs/common';
import { NotFoundError } from '@shipkeep/domain';

import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import { type ResourceSecurityContext as SecurityContext } from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import { APPLICATION_STORE, type ApplicationStore } from '../../apps/application/ports';
import type { ApplicationTarget } from '../../apps/domain/application';
import {
  applicationQueries,
  MAX_QUERY_ENVIRONMENTS,
  nodeQueries,
  organizationQueries,
  type Range,
  RANGES,
} from '../domain/metrics';

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
 * `node.manage`, the organization's requests with `organization.read` over the environments the
 * caller may read with `observability.read`. The query is built from identifiers checked here,
 * for the caller's organization, after the application or the server was found in it.
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

  /**
   * Requests of the organization's applications. Owners and admins read every environment; another
   * member reads the environments `observability.read` allows, among the first 100 of the
   * organization (SPEC 12), and none at all reads no series.
   */
  organization(
    context: SecurityContext,
    organizationId: string,
    range: Range,
    now = new Date(),
  ): Promise<MetricsAnswer<'requests' | 'duration'>> {
    return this.accounts.run(context, async () => {
      await this.access.require(context.userId, 'organization.read', { organizationId });
      let environments: string[] | null = null;
      if (!(await this.access.allows(context.userId, 'observability.read', { organizationId }))) {
        const all = await this.transaction.runTenant(organizationId, () =>
          this.targets.environments(organizationId, MAX_QUERY_ENVIRONMENTS),
        );
        environments = [];
        for (const environment of all)
          if (
            await this.access.allows(context.userId, 'observability.read', {
              organizationId,
              projectId: environment.projectId,
              environmentId: environment.id,
            })
          )
            environments.push(environment.id);
      }
      if (environments?.length === 0)
        return this.answer({ requests: null, duration: null }, range, now);
      return this.answer(organizationQueries(organizationId, environments, range), range, now);
    });
  }

  /** Each named query's series; a null query reads nothing and answers no series. */
  private async answer<K extends string>(
    queries: Readonly<Record<K, string | null>>,
    range: Range,
    now: Date,
  ): Promise<MetricsAnswer<K>> {
    const { seconds, step } = RANGES[range];
    const from = new Date(now.getTime() - seconds * 1000);
    const names = Object.keys(queries) as K[];
    const store = this.store;
    const results = await Promise.all(
      names.map((name) => {
        const query = queries[name];
        return store && query !== null
          ? store.queryRange(query, from, now, step)
          : Promise.resolve<Series[]>([]);
      }),
    );
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
