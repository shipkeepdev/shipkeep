import type { ContainerTarget, HostTarget } from '../domain/metrics';

export const METRICS_TARGETS = Symbol('MetricsTargets');
/** The workloads a node runs, from the control plane's records. Runs inside `runTenant`. */
export interface MetricsTargets {
  /**
   * The node's placed allocations among these container names, and the domains among these host
   * names whose application has a placed allocation on the node.
   */
  onNode(
    organizationId: string,
    nodeId: string,
    containers: readonly string[],
    hosts: readonly string[],
  ): Promise<{ containers: ContainerTarget[]; hosts: HostTarget[] }>;
  /** Whether the node belongs to the organization. */
  nodeExists(organizationId: string, nodeId: string): Promise<boolean>;
  /**
   * The organization's environments with their project, at most `limit`, in identifier order,
   * after the identifier `after` when given (one page of a keyset walk).
   */
  environments(
    organizationId: string,
    limit: number,
    after?: string,
  ): Promise<readonly { readonly id: string; readonly projectId: string }[]>;
}

/** One series of a query, its points as [unix seconds, value]. */
export interface Series {
  readonly labels: Readonly<Record<string, string>>;
  readonly points: readonly (readonly [number, number])[];
}

export const METRICS_STORE = Symbol('MetricsStore');
/** VictoriaMetrics, or null when none is configured. */
export interface MetricsStore {
  write(exposition: string): Promise<void>;
  queryRange(query: string, start: Date, end: Date, stepSeconds: number): Promise<Series[]>;
  /** The value of a query at one time: each series holds that single point. */
  queryInstant(query: string, at: Date): Promise<Series[]>;
}

export const METRICS_TRANSACTION = Symbol('MetricsTransaction');
export interface MetricsTransaction {
  runTenant<T>(organizationId: string, work: () => Promise<T>): Promise<T>;
}
