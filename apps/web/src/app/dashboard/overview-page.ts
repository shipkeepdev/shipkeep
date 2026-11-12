import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { type AuditEvent } from '../audit/audit-api';
import { Icon } from '../shell/icon';
import { type IconName } from '../shell/icons';
import { ShellContext } from '../shell/shell-context';
import { I18n, T } from '../ui/i18n';
import { OverviewStore } from '../workspace/overview-store';
import {
  AMBER,
  ageSeconds,
  bytes,
  clock,
  deploymentStatus,
  duration,
  GREEN,
  nodeStatus,
  percent,
  RED,
  shortDate,
} from './format';
import { RequestsChart } from './requests-chart';

interface Kpi {
  readonly icon: IconName;
  readonly label: string;
  readonly value: string;
  readonly unit: string;
  readonly delta: string;
  readonly deltaValues?: Readonly<Record<string, string | number>>;
  readonly deltaColor: string;
  readonly sub: string;
  readonly subValues?: Readonly<Record<string, string | number>>;
}

interface Alert {
  readonly title: string;
  readonly titleValues: Readonly<Record<string, string>>;
  readonly sub: string;
  readonly subValues?: Readonly<Record<string, string | number>>;
  readonly color: string;
  readonly at: string;
}

const DAY = 24 * 60 * 60 * 1000;

/** 01 Overview: what runs, what is wrong and what happened, for the whole organization. */
@Component({
  selector: 'sk-overview-page',
  imports: [Icon, RequestsChart, RouterLink, T],
  providers: [OverviewStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './overview-page.html',
})
export class OverviewPage {
  protected readonly store = inject(OverviewStore);
  protected readonly shell = inject(ShellContext);
  private readonly i18n = inject(I18n);
  protected readonly organizationId = computed(() => this.shell.organizationId() ?? '');
  protected readonly status = deploymentStatus;
  protected readonly nodeStatus = nodeStatus;
  protected readonly duration = duration;

  protected readonly kpis = computed((): readonly Kpi[] => {
    const apps = this.store.applications();
    const live = apps.filter((a) => a.deployments.at(0)?.state === 'succeeded').length;
    const failing = apps.filter((a) => a.deployments.at(0)?.state === 'failed');
    const visible = this.store.nodes() !== null || this.store.loading();
    const nodes = this.store.nodes() ?? [];
    const ready = nodes.filter((n) => n.status === 'ready').length;
    const unwell = nodes.filter((n) => n.status === 'suspect' || n.status === 'down');
    const firstUnwell = unwell.at(0);
    const since = Date.now() - DAY;
    const today = apps
      .flatMap((a) => a.deployments)
      .filter((d) => Date.parse(d.startedAt) >= since);
    const finished = today
      .filter((d) => d.finishedAt)
      .map((d) => (Date.parse(d.finishedAt ?? d.startedAt) - Date.parse(d.startedAt)) / 1000)
      .sort((a, b) => a - b);
    const median = finished.length
      ? Math.round(finished[Math.floor(finished.length / 2)] ?? 0)
      : null;
    const count = (state: string) => today.filter((d) => d.state === state).length;
    return [
      {
        icon: 'apps',
        label: 'Apps live',
        value: String(live),
        unit: `/ ${String(apps.length)}`,
        delta: failing.length ? '{n} failing' : '',
        deltaValues: { n: failing.length },
        deltaColor: RED,
        sub: failing.length
          ? '{names}'
          : apps.length
            ? 'Every application runs its last release'
            : 'No application yet',
        subValues: { names: failing.map((a) => `${a.name} · ${a.project}`).join(', ') },
      },
      {
        icon: 'server-2',
        label: 'Servers ready',
        value: visible ? String(ready) : '—',
        unit: visible ? `/ ${String(nodes.length)}` : '',
        delta: unwell.length ? '{n} suspect' : '',
        deltaValues: { n: unwell.length },
        deltaColor: AMBER,
        sub: !visible
          ? 'Visible to administrators'
          : firstUnwell
            ? '{name} no heartbeat for {s} s'
            : nodes.length
              ? 'Every server sends heartbeats'
              : 'No server connected yet',
        subValues: firstUnwell
          ? { name: firstUnwell.name, s: ageSeconds(firstUnwell.lastHeartbeatAt) ?? '—' }
          : undefined,
      },
      {
        icon: 'rocket',
        label: 'Deployments · 24 h',
        value: String(today.length),
        unit: '',
        delta: median === null ? '' : 'median {s} s',
        deltaValues: { s: median ?? 0 },
        deltaColor: '#8B8B93',
        sub: '{live} live · {failed} failed · {cancelled} cancelled',
        subValues: {
          live: count('succeeded'),
          failed: count('failed'),
          cancelled: count('cancelled'),
        },
      },
      {
        icon: 'database',
        label: 'Backups',
        value: '—',
        unit: '',
        delta: '',
        deltaColor: GREEN,
        sub: 'Database backups are not built yet',
      },
    ];
  });

  protected readonly tiles = computed(() =>
    (this.store.nodes() ?? []).slice(0, 6).map((node) => {
      const facts = node.facts as Record<string, unknown>;
      const disk = typeof facts['disk_bytes'] === 'number' ? facts['disk_bytes'] : 0;
      const free = typeof facts['disk_free_bytes'] === 'number' ? facts['disk_free_bytes'] : 0;
      const cpus = typeof facts['cpu_count'] === 'number' ? facts['cpu_count'] : null;
      return {
        node,
        status: nodeStatus(node.status),
        disk: disk ? percent(disk - free, disk) : null,
        spec: [cpus ? `${String(cpus)} CPU` : null, bytes(facts['memory_bytes'])]
          .filter(Boolean)
          .join(' · '),
      };
    }),
  );

  protected readonly alerts = computed((): readonly Alert[] => {
    const failed = this.store
      .applications()
      .filter((a) => a.deployments.at(0)?.state === 'failed')
      .map((a) => {
        const d = a.deployments.at(0);
        return {
          title: '{name}: deployment failed',
          titleValues: { name: a.name },
          sub: d?.error ? '{error}' : 'The previous release keeps serving',
          subValues: { error: d?.error ?? '' },
          color: RED,
          at: d ? clock(d.finishedAt ?? d.startedAt) : '',
        };
      });
    const nodes = (this.store.nodes() ?? [])
      .filter((n) => n.status === 'suspect' || n.status === 'down')
      .map((n) => ({
        title: n.status === 'down' ? '{name} down' : '{name} suspect',
        titleValues: { name: n.name },
        sub: 'No heartbeat for {s} s',
        subValues: { s: ageSeconds(n.lastHeartbeatAt) ?? '—' },
        color: n.status === 'down' ? RED : AMBER,
        at: n.lastHeartbeatAt ? clock(n.lastHeartbeatAt) : '',
      }));
    return [...failed, ...nodes];
  });

  protected readonly summary = computed(() => ({
    projects: this.store.projectCount(),
    environments: this.store.environmentCount(),
    servers: this.store.nodes()?.length ?? 0,
  }));

  constructor() {
    effect(() => {
      const id = this.shell.organizationId();
      if (id) void this.store.load(id);
    });
  }

  protected actor(event: AuditEvent): string {
    if (event.actorKind === 'system') return this.i18n.t('system');
    if (event.actorKind === 'node') return this.i18n.t('agent');
    if (event.actorKind === 'api_token') return this.i18n.t('API token');
    const email = event.actorId ? this.shell.emails().get(event.actorId) : undefined;
    return email ?? this.i18n.t('user');
  }

  protected when(at: string): string {
    return shortDate(at).slice(6);
  }
}
