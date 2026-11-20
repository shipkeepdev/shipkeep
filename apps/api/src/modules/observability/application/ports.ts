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
}

export const METRICS_TRANSACTION = Symbol('MetricsTransaction');
export interface MetricsTransaction {
  runTenant<T>(organizationId: string, work: () => Promise<T>): Promise<T>;
}
