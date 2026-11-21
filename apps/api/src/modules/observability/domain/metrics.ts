/**
 * Metrics a node reports (ADR 0024, SPEC 12): what is read from a report once validated, the
 * samples written for it, with labels the control plane sets itself, and the queries that read
 * them back. Pure: no framework, database or network.
 */

export const MAX_CONTAINERS = 256;
export const MAX_HOSTS = 64;
/** Gauges (memory, disk, cores) above this are not a real measure: 1 PB. */
const MAX_GAUGE = 1e15;
/**
 * Cumulative counters (CPU seconds, bytes, responses) only grow: they are bounded by the largest
 * integer a number holds exactly, not by what a gauge can reach.
 */
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

export interface NodeMeasure {
  readonly cpuSeconds: number;
  readonly cpuCores: number;
  readonly memoryUsedBytes: number;
  readonly memoryTotalBytes: number;
  readonly diskUsedBytes: number;
  readonly diskTotalBytes: number;
  readonly networkReceivedBytes: number;
  readonly networkSentBytes: number;
}

export interface ContainerMeasure {
  readonly name: string;
  readonly cpuSeconds: number;
  readonly memoryUsedBytes: number;
  readonly memoryLimitBytes: number;
  readonly networkReceivedBytes: number;
  readonly networkSentBytes: number;
}

export interface HostMeasure {
  readonly host: string;
  readonly responses2xx: number;
  readonly responses3xx: number;
  readonly responses4xx: number;
  readonly responses5xx: number;
  readonly responsesOther: number;
  readonly durationSeconds: number;
}

export interface Measures {
  readonly node: NodeMeasure | undefined;
  readonly containers: readonly ContainerMeasure[];
  readonly hosts: readonly HostMeasure[];
}

const CONTAINER = /^sk-[a-z0-9-]{1,60}$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

/** A value a node may report: finite, not negative, not above its kind's bound. */
function valid(value: number, max: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= max;
}
const gauge = (value: number) => valid(value, MAX_GAUGE);
const counter = (value: number) => valid(value, MAX_COUNTER);

/** The measures of a report, or undefined when any is out of bounds: never part of a report. */
export function validMeasures(measures: Measures): Measures | undefined {
  if (measures.containers.length > MAX_CONTAINERS || measures.hosts.length > MAX_HOSTS)
    return undefined;
  const { node } = measures;
  if (
    node &&
    !(
      [
        node.cpuCores,
        node.memoryUsedBytes,
        node.memoryTotalBytes,
        node.diskUsedBytes,
        node.diskTotalBytes,
      ].every(gauge) &&
      [node.cpuSeconds, node.networkReceivedBytes, node.networkSentBytes].every(counter)
    )
  )
    return undefined;
  for (const container of measures.containers) {
    if (!CONTAINER.test(container.name)) return undefined;
    if (
      ![container.memoryUsedBytes, container.memoryLimitBytes].every(gauge) ||
      ![container.cpuSeconds, container.networkReceivedBytes, container.networkSentBytes].every(
        counter,
      )
    )
      return undefined;
  }
  for (const host of measures.hosts) {
    if (!HOST.test(host.host) || host.host.includes('..')) return undefined;
    if (
      ![
        host.responses2xx,
        host.responses3xx,
        host.responses4xx,
        host.responses5xx,
        host.responsesOther,
        host.durationSeconds,
      ].every(counter)
    )
      return undefined;
  }
  return measures;
}

/** The workloads a node runs, read from the control plane's own records. */
export interface Workload {
  readonly projectId: string;
  readonly environmentId: string;
  readonly applicationId: string;
}
export interface ContainerTarget extends Workload {
  readonly container: string;
  readonly replica: number;
}
export interface HostTarget extends Workload {
  readonly hostname: string;
}

export interface Sample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

/**
 * The samples of a report. Every label comes from the node's identity and the targets the control
 * plane found for it: a container or host name that maps to none is dropped, and nothing the
 * agent sent becomes a label as it came.
 */
export function samples(
  measures: Measures,
  node: { readonly organizationId: string; readonly nodeId: string },
  containers: readonly ContainerTarget[],
  hosts: readonly HostTarget[],
): Sample[] {
  const out: Sample[] = [];
  const nodeLabels = { organization_id: node.organizationId, node_id: node.nodeId };
  const push = (name: string, labels: Record<string, string>, value: number) => {
    out.push({ name, labels, value });
  };
  if (measures.node) {
    const n = measures.node;
    push('shipkeep_node_cpu_seconds_total', nodeLabels, n.cpuSeconds);
    push('shipkeep_node_cpu_cores', nodeLabels, n.cpuCores);
    push('shipkeep_node_memory_used_bytes', nodeLabels, n.memoryUsedBytes);
    push('shipkeep_node_memory_total_bytes', nodeLabels, n.memoryTotalBytes);
    push('shipkeep_node_disk_used_bytes', nodeLabels, n.diskUsedBytes);
    push('shipkeep_node_disk_total_bytes', nodeLabels, n.diskTotalBytes);
    push('shipkeep_node_network_received_bytes_total', nodeLabels, n.networkReceivedBytes);
    push('shipkeep_node_network_sent_bytes_total', nodeLabels, n.networkSentBytes);
  }
  const byContainer = new Map(containers.map((target) => [target.container, target]));
  for (const measure of measures.containers) {
    const target = byContainer.get(measure.name);
    if (!target) continue;
    // The container name tells apart the old and new release of one replica during a rollout.
    const labels = {
      ...nodeLabels,
      ...workload(target),
      replica: String(target.replica),
      container: target.container,
    };
    push('shipkeep_container_cpu_seconds_total', labels, measure.cpuSeconds);
    push('shipkeep_container_memory_used_bytes', labels, measure.memoryUsedBytes);
    push('shipkeep_container_memory_limit_bytes', labels, measure.memoryLimitBytes);
    push('shipkeep_container_network_received_bytes_total', labels, measure.networkReceivedBytes);
    push('shipkeep_container_network_sent_bytes_total', labels, measure.networkSentBytes);
  }
  const byHost = new Map(hosts.map((target) => [target.hostname, target]));
  for (const measure of measures.hosts) {
    const target = byHost.get(measure.host);
    if (!target) continue;
    const labels = { ...nodeLabels, ...workload(target), domain: target.hostname };
    for (const [status, value] of [
      ['2xx', measure.responses2xx],
      ['3xx', measure.responses3xx],
      ['4xx', measure.responses4xx],
      ['5xx', measure.responses5xx],
      ['other', measure.responsesOther],
    ] as const)
      push('shipkeep_route_responses_total', { ...labels, status }, value);
    push('shipkeep_route_duration_seconds_total', labels, measure.durationSeconds);
  }
  return out;
}

function workload(target: Workload): Record<string, string> {
  return {
    project_id: target.projectId,
    environment_id: target.environmentId,
    application_id: target.applicationId,
  };
}

/**
 * Samples in the Prometheus text format with their time, as VictoriaMetrics imports them. Label
 * values are escaped even though every one the control plane sets is an identifier or a domain.
 */
export function exposition(samples: readonly Sample[], at: Date): string {
  const time = at.getTime();
  return samples
    .map((sample) => {
      const labels = Object.entries(sample.labels)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => `${key}="${escape(value)}"`)
        .join(',');
      return `${sample.name}{${labels}} ${String(sample.value)} ${String(time)}\n`;
    })
    .join('');
}

function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** The periods a chart shows, with the step between two points. */
export const RANGES = {
  '1h': { seconds: 3600, step: 30 },
  '24h': { seconds: 86_400, step: 300 },
  '7d': { seconds: 604_800, step: 1800 },
  '30d': { seconds: 2_592_000, step: 10_800 },
} as const;
export type Range = keyof typeof RANGES;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A label filter for identifiers only, checked here: a query is never built from anything else. */
function filter(labels: Readonly<Record<string, string>>): string {
  for (const value of Object.values(labels))
    if (!UUID.test(value)) throw new Error('metric query filters take identifiers only');
  return Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',');
}

/** The window of a rate: at least two samples of 30 seconds, and at least one step. */
function window(range: Range): string {
  return `${String(Math.max(120, RANGES[range].step))}s`;
}

/** Queries of an application's charts: CPU in cores, memory in bytes, requests per second by status, mean duration. */
export function applicationQueries(
  organizationId: string,
  applicationId: string,
  range: Range,
): Readonly<Record<'cpu' | 'memory' | 'requests' | 'duration', string>> {
  const where = filter({ organization_id: organizationId, application_id: applicationId });
  const w = window(range);
  return {
    cpu: `sum(rate(shipkeep_container_cpu_seconds_total{${where}}[${w}]))`,
    memory: `sum(shipkeep_container_memory_used_bytes{${where}})`,
    requests: `sum by (status) (rate(shipkeep_route_responses_total{${where}}[${w}]))`,
    duration: `sum(rate(shipkeep_route_duration_seconds_total{${where}}[${w}])) / sum(rate(shipkeep_route_responses_total{${where}}[${w}]))`,
  };
}

/** Queries of a server's charts: CPU in cores, memory and disk in bytes, network in bytes per second. */
export function nodeQueries(
  organizationId: string,
  nodeId: string,
  range: Range,
): Readonly<
  Record<'cpu' | 'memory' | 'memoryTotal' | 'disk' | 'diskTotal' | 'received' | 'sent', string>
> {
  const where = filter({ organization_id: organizationId, node_id: nodeId });
  const w = window(range);
  return {
    cpu: `sum(rate(shipkeep_node_cpu_seconds_total{${where}}[${w}]))`,
    memory: `max(shipkeep_node_memory_used_bytes{${where}})`,
    memoryTotal: `max(shipkeep_node_memory_total_bytes{${where}})`,
    disk: `max(shipkeep_node_disk_used_bytes{${where}})`,
    diskTotal: `max(shipkeep_node_disk_total_bytes{${where}})`,
    received: `sum(rate(shipkeep_node_network_received_bytes_total{${where}}[${w}]))`,
    sent: `sum(rate(shipkeep_node_network_sent_bytes_total{${where}}[${w}]))`,
  };
}

/** At most this many environments are named in one query: a member's charts cover those. */
export const MAX_QUERY_ENVIRONMENTS = 100;

/**
 * Queries of the organization's requests chart: requests per second by status class and mean
 * duration, over all its environments (null), or over the environments given, the ones the caller
 * may read. Every identifier is checked: a query is never built from anything else.
 */
export function organizationQueries(
  organizationId: string,
  environmentIds: readonly string[] | null,
  range: Range,
): Readonly<Record<'requests' | 'duration', string>> {
  if (
    environmentIds &&
    (environmentIds.length === 0 || environmentIds.length > MAX_QUERY_ENVIRONMENTS)
  )
    throw new Error('metric queries name 1 to 100 environments');
  for (const id of environmentIds ?? [])
    if (!UUID.test(id)) throw new Error('metric query filters take identifiers only');
  const where =
    filter({ organization_id: organizationId }) +
    (environmentIds ? `,environment_id=~"${environmentIds.join('|')}"` : '');
  const w = window(range);
  return {
    requests: `sum by (status) (rate(shipkeep_route_responses_total{${where}}[${w}]))`,
    duration: `sum(rate(shipkeep_route_duration_seconds_total{${where}}[${w}])) / sum(rate(shipkeep_route_responses_total{${where}}[${w}]))`,
  };
}
