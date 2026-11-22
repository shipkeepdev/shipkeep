import { type IconName } from '../shell/icons';
import {
  ageSeconds,
  bytes,
  nodeStatus,
  percent,
  replicaStatus,
  type Status,
} from '../dashboard/format';

import { type FleetNode, type NodeReplica } from './fleet-api';

/**
 * Text for the page: English source text with its values, translated by the page. `count` picks
 * the singular (`t`) or plural (`other`) form of `n`.
 */
export interface Text {
  readonly t: string;
  readonly values?: Readonly<Record<string, string | number>>;
  readonly count?: { readonly n: number; readonly other: string };
}

export interface ServerStat {
  readonly icon: IconName;
  readonly label: string;
  /** Measured values go through `raw`, so they are never translated. */
  readonly value: Text;
  readonly sub?: Text;
  readonly color?: string;
}

export interface ServerField {
  readonly label: string;
  /** Reported by the agent or typed by a person: shown as is. Null when absent. */
  readonly value: string | null;
  /** What absence means, as source text. */
  readonly none?: string;
  readonly mono?: boolean;
}

export interface ReplicaRow {
  readonly id: string;
  readonly application: string;
  readonly place: string;
  readonly link: readonly string[];
  readonly replica: number;
  /** `#n` when the application runs more than one replica on this server; null otherwise. */
  readonly replicaLabel: string | null;
  readonly container: string;
  /** CPU reserved, in cores; the page writes it in the interface language. Null when none. */
  readonly cpu: number | null;
  readonly memory: string;
  readonly status: Status | null;
}

export interface ServerView {
  readonly name: string;
  readonly status: Status;
  /** Hostname and operating system, as reported. */
  readonly sub: string;
  readonly agentVersion: string | null;
  readonly stats: readonly ServerStat[];
  readonly machine: readonly ServerField[];
  readonly agent: readonly ServerStat[];
  readonly rows: readonly ReplicaRow[];
  readonly truncated: boolean;
}

/** A server's page from what its agent reported and what runs on it (#264). Pure. */
export function serverView(
  organizationId: string,
  node: FleetNode,
  replicas: { readonly items: readonly NodeReplica[]; readonly truncated: boolean },
  now = Date.now(),
): ServerView {
  const facts = node.facts as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = facts[key];
    return typeof value === 'string' && value.trim() ? value : null;
  };
  const number = (key: string): number | null => {
    const value = facts[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  };
  const cpu = number('cpu_count');
  const memory = number('memory_bytes');
  const disk = number('disk_bytes');
  // A reported 0 means a full disk; an absent value is unknown, never read as full.
  const reportedFree = facts['disk_free_bytes'];
  const free =
    disk !== null &&
    typeof reportedFree === 'number' &&
    Number.isFinite(reportedFree) &&
    reportedFree >= 0 &&
    reportedFree <= disk
      ? reportedFree
      : null;
  const used = disk !== null && free !== null ? disk - free : null;
  const usedPercent = disk !== null && used !== null ? percent(used, disk) : null;
  const reservedCpu = number('reserved_cpu_millis');
  const reservedMemory = number('reserved_memory_bytes');
  const status = nodeStatus(node.status);
  const beat = ageSeconds(node.lastHeartbeatAt, now);
  const perApplication = new Map<string, number>();
  for (const replica of replicas.items)
    perApplication.set(
      replica.application.id,
      (perApplication.get(replica.application.id) ?? 0) + 1,
    );
  const applications = perApplication.size;
  const labels = Object.entries(node.labels as Record<string, unknown>).map(
    ([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
  const os = [text('os'), text('os_version')].filter(Boolean).join(' ');
  return {
    name: node.name,
    status,
    sub: [text('hostname'), os, text('architecture')].filter(Boolean).join(' · '),
    agentVersion: text('agent_version'),
    stats: [
      {
        icon: 'cpu',
        label: 'CPU',
        value: cpu === null ? raw('—') : { t: '{n} core', count: { n: cpu, other: '{n} cores' } },
        sub: reservedCpu
          ? { t: '{cpu} reserved for the control plane', values: { cpu: reservedCpu / 1000 } }
          : undefined,
      },
      {
        icon: 'device-sd-card',
        label: 'Memory',
        value: raw(bytes(memory) ?? '—'),
        sub: reservedMemory
          ? {
              t: '{memory} reserved for the control plane',
              values: { memory: bytes(reservedMemory) ?? '' },
            }
          : undefined,
      },
      {
        icon: 'database',
        label: 'Disk',
        value: raw(used === null ? '—' : (bytes(used) ?? '0')),
        sub:
          disk === null
            ? undefined
            : usedPercent === null
              ? { t: 'of {total}', values: { total: bytes(disk) ?? '' } }
              : {
                  t: 'of {total} · {percent} %',
                  values: { total: bytes(disk) ?? '', percent: usedPercent },
                },
        color: usedPercent !== null && usedPercent >= 85 ? 'oklch(0.80 0.12 80)' : undefined,
      },
      {
        icon: 'box',
        label: 'Replicas',
        value: raw(
          replicas.truncated ? `${String(replicas.items.length)}+` : String(replicas.items.length),
        ),
        sub: { t: '{n} application', count: { n: applications, other: '{n} applications' } },
      },
    ],
    machine: [
      { label: 'Name', value: node.name, mono: true },
      { label: 'Hostname', value: text('hostname'), mono: true },
      { label: 'Operating system', value: os || null },
      { label: 'Kernel', value: text('kernel_version'), mono: true },
      { label: 'Architecture', value: text('architecture'), mono: true },
      { label: 'Docker', value: text('docker_version'), mono: true },
      { label: 'Caddy', value: text('caddy_version'), mono: true },
      {
        label: 'Placement labels',
        value: labels.join(', ') || null,
        none: 'No label',
        mono: true,
      },
      {
        label: 'Public addresses',
        value: node.publicAddresses.join(', ') || null,
        none: 'None declared',
        mono: true,
      },
    ],
    agent: [
      {
        icon: 'heartbeat',
        label: 'Last heartbeat',
        value: beat === null ? { t: 'never' } : { t: '{s} s ago', values: { s: beat } },
        sub: { t: 'suspect after 15 s without one' },
        color: beat === null ? undefined : status.color,
      },
      { icon: 'clock', label: 'Epoch', value: raw(String(node.leaseEpoch)) },
      { icon: 'plug-connected', label: 'Version', value: raw(text('agent_version') ?? '—') },
    ],
    rows: replicas.items.map((replica) => ({
      id: replica.id,
      application: replica.application.name,
      place: `${replica.project.name} · ${replica.environment.name}`,
      link: [
        '/orgs',
        organizationId,
        'projects',
        replica.project.id,
        'environments',
        replica.environment.id,
        'applications',
        replica.application.id,
      ],
      replica: replica.replica,
      replicaLabel:
        (perApplication.get(replica.application.id) ?? 0) > 1
          ? `#${String(replica.replica)}`
          : null,
      container: replica.container,
      cpu: replica.cpuMillis ? replica.cpuMillis / 1000 : null,
      memory: bytes(replica.memoryBytes) ?? '—',
      status: replicaStatus(replica),
    })),
    truncated: replicas.truncated,
  };
}

/** A measured or typed value: shown as is, never looked up for translation. */
export function raw(value: string): Text {
  return { t: '{v}', values: { v: value } };
}
