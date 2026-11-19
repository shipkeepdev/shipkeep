/** Runtime states the agent reports, plus `missing` for a seen container that is gone. */
export const OBSERVED_STATES = [
  'created',
  'running',
  'paused',
  'restarting',
  'exited',
  'dead',
  'missing',
] as const;
export type ObservedState = (typeof OBSERVED_STATES)[number];

/** Why an agent stopped a container itself (ADR 0022): what `ContainerStatus.stop_reason` may say. */
export const STOP_REASONS = ['disk_limit'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** States in which a container is stopped, the only ones a stop reason describes. */
const STOPPED_STATES: readonly ObservedState[] = ['exited', 'dead'];

/** A stop reason the control plane knows, or null for none or one it does not know. */
export function stopReason(value: string): StopReason | null {
  return STOP_REASONS.find((reason) => reason === value) ?? null;
}

/** Unchanged observations are refreshed this often, so `observedAt` shows the agent still reports. */
export const OBSERVATION_REFRESH_MS = 60_000;

export interface ReportedContainer {
  readonly containerId: string;
  readonly name: string;
  readonly state: Exclude<ObservedState, 'missing'>;
  readonly stopReason: StopReason | null;
}

/** A placed replica on the reporting node, with what was last observed for it. */
export interface ObservedAllocation {
  readonly id: string;
  readonly applicationId: string;
  readonly environmentId: string;
  readonly container: string;
  readonly observation: {
    readonly state: ObservedState;
    readonly stopReason: StopReason | null;
    readonly observedAt: Date;
  } | null;
}

export interface ObservationChange {
  readonly allocationId: string;
  readonly applicationId: string;
  readonly environmentId: string;
  readonly container: string;
  /** Null once the container is gone. */
  readonly containerId: string | null;
  readonly state: ObservedState;
  /** Why the agent stopped it itself, while the container exists. */
  readonly stopReason: StopReason | null;
  /** The previous state, or null the first time this allocation is seen. */
  readonly from: ObservedState | null;
  /** False for a refresh of an unchanged state: only real changes are audited. */
  readonly changed: boolean;
}

/**
 * Compares one complete report with the node's placed replicas. Containers that match no replica
 * are ignored, so a report can never touch another node's allocations. A replica that was never
 * seen stays unobserved when absent: its container may simply not be created yet.
 */
export function observationChanges(
  allocations: readonly ObservedAllocation[],
  reported: readonly ReportedContainer[],
  now: Date,
): ObservationChange[] {
  const containers = new Map(reported.map((container) => [container.name, container]));
  const changes: ObservationChange[] = [];
  for (const allocation of allocations) {
    const container = containers.get(allocation.container);
    const previous = allocation.observation;
    if (!container && !previous) continue;
    const state = container?.state ?? 'missing';
    // A reason paired with a state that is not stopped describes nothing: it is dropped.
    const reason =
      container && STOPPED_STATES.includes(container.state) ? container.stopReason : null;
    const changed = previous?.state !== state || previous.stopReason !== reason;
    if (!changed && now.getTime() - previous.observedAt.getTime() < OBSERVATION_REFRESH_MS)
      continue;
    changes.push({
      allocationId: allocation.id,
      applicationId: allocation.applicationId,
      environmentId: allocation.environmentId,
      container: allocation.container,
      containerId: container?.containerId ?? null,
      state,
      stopReason: reason,
      from: previous?.state ?? null,
      changed,
    });
  }
  return changes;
}

/** A placed replica as the API shows it: where it runs and what its agent last saw. */
export interface ReplicaStatus {
  readonly id: string;
  readonly releaseId: string;
  readonly replica: number;
  readonly nodeId: string;
  readonly nodeName: string;
  readonly container: string;
  /** Null until its agent has seen the container. */
  readonly state: ObservedState | null;
  /** Why its agent stopped it itself (ADR 0022); null otherwise. */
  readonly stopReason: StopReason | null;
  readonly observedAt: Date | null;
}
