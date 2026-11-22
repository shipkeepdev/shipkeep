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
  readonly container: string;
  readonly cpu: string;
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
  const free = number('disk_free_bytes') ?? 0;
  const reservedCpu = number('reserved_cpu_millis');
  const reservedMemory = number('reserved_memory_bytes');
  const status = nodeStatus(node.status);
  const beat = ageSeconds(node.lastHeartbeatAt, now);
  const applications = new Set(replicas.items.map((replica) => replica.application.id)).size;
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
          ? { t: '{cpu} reserved for the control plane', values: { cpu: cores(reservedCpu) } }
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
        value: raw(disk === null ? '—' : `${String(percent(disk - free, disk))} %`),
        sub:
          disk === null
            ? undefined
            : {
                t: '{free} free of {total}',
                values: { free: bytes(free) ?? '0', total: bytes(disk) ?? '' },
              },
        color:
          disk !== null && percent(disk - free, disk) >= 85 ? 'oklch(0.80 0.12 80)' : undefined,
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
      { label: 'Placement labels', value: labels.join(', ') || null, none: 'None', mono: true },
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
      { icon: 'clock', label: 'Lease epoch', value: raw(String(node.leaseEpoch)) },
      { icon: 'plug-connected', label: 'Agent version', value: raw(text('agent_version') ?? '—') },
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
      container: replica.container,
      cpu: replica.cpuMillis ? cores(replica.cpuMillis) : '—',
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

/** Millicores as a number of cores: 250 → "0.25". */
function cores(millis: number): string {
  return String(Number((millis / 1000).toFixed(2)));
}
