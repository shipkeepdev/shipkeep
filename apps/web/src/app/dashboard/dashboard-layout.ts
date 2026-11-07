import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';

import { SessionStore } from '../identity/session-store';
import { Icon } from '../shell/icon';
import { type IconName } from '../shell/icons';
import { Logo } from '../shell/logo';
import { ShellContext } from '../shell/shell-context';
import { I18n, LANGUAGES, T } from '../ui/i18n';
import { Notice } from '../ui/notice';
import { CommandPalette, type PaletteEntry } from './command-palette';
import { type Crumb, PageCrumbs } from './page-crumbs';
import { VIEW_PATHS } from './views';

interface NavEntry {
  readonly view: string;
  readonly label: string;
  readonly icon: IconName;
  readonly count?: () => number | null;
  readonly alert?: boolean;
}

const initials = (text: string) =>
  text
    .split(/[\s._@-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.at(0)?.toUpperCase() ?? '')
    .join('');

/** The dashboard frame from the design: sidebar, top bar and the current page. */
@Component({
  selector: 'sk-dashboard-layout',
  imports: [CommandPalette, Icon, Logo, RouterLink, RouterOutlet, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard-layout.html',
  host: { '(document:keydown)': 'shortcut($event)' },
})
export class DashboardLayout {
  protected readonly shell = inject(ShellContext);
  protected readonly session = inject(SessionStore);
  protected readonly i18n = inject(I18n);
  protected readonly notice = inject(Notice);
  protected readonly languages = LANGUAGES;
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly crumbs = inject(PageCrumbs);
  private readonly document = inject(DOCUMENT);
  protected readonly menuOpen = signal(false);
  protected readonly orgMenuOpen = signal(false);
  protected readonly paletteOpen = signal(false);
  private readonly navigation = toSignal(
    this.router.events.pipe(filter((event) => event instanceof NavigationEnd)),
  );

  protected readonly platform: readonly NavEntry[] = [
    { view: 'overview', label: 'Overview', icon: 'layout-dashboard' },
    { view: 'app', label: 'Applications', icon: 'apps' },
    { view: 'previews', label: 'Previews', icon: 'git-pull-request' },
    {
      view: 'servers',
      label: 'Servers',
      icon: 'server-2',
      count: () => this.shell.nodes()?.length ?? null,
    },
    { view: 'data', label: 'Databases', icon: 'database' },
    { view: 'obs', label: 'Observability', icon: 'activity' },
    { view: 'audit', label: 'Audit log', icon: 'file-certificate' },
    { view: 'access', label: 'Members & access', icon: 'users', count: () => this.shell.members() },
  ];
  protected readonly infrastructure: readonly NavEntry[] = [
    { view: 'integrations', label: 'Integrations', icon: 'plug' },
    { view: 'sharedvars', label: 'Shared variables', icon: 'variable' },
    { view: 'terminal', label: 'Terminal', icon: 'terminal-2' },
    { view: 'vulns', label: 'Vulnerabilities', icon: 'bug' },
  ];
  protected readonly manage: readonly NavEntry[] = [
    { view: 'projects', label: 'Projects', icon: 'folders' },
    { view: 'org', label: 'Organization', icon: 'building' },
    { view: 'notifs', label: 'Notifications', icon: 'bell' },
    { view: 'tags', label: 'Tags', icon: 'tags' },
    { view: 'settings', label: 'Settings', icon: 'settings' },
    { view: 'onboarding', label: 'First start', icon: 'flag' },
  ];

  protected readonly organizationId = computed(() => this.shell.organizationId() ?? '');
  protected readonly orgInitials = computed(() => initials(this.shell.organization()?.name ?? ''));
  protected readonly userInitials = computed(() =>
    initials(this.session.profile()?.email.split('@').at(0) ?? ''),
  );
  protected readonly roleLabel = computed(() => {
    const role = this.shell.role();
    return role ? { owner: 'Owner', admin: 'Admin', member: 'Member' }[role] : null;
  });
  protected readonly trail = computed<readonly Crumb[]>(() => {
    const name = this.shell.organization()?.name;
    return [
      ...(name ? [{ label: name, raw: true, link: ['/orgs', this.organizationId()] }] : []),
      ...this.crumbs.trail(),
    ];
  });
  protected readonly paletteEntries = computed<readonly PaletteEntry[]>(() => {
    const id = this.organizationId();
    return [
      ...[...this.platform, ...this.infrastructure, ...this.manage].map((entry) => ({
        label: entry.label,
        icon: entry.icon,
        link: this.link(entry.view),
      })),
      ...this.shell.projects().map((project) => ({
        label: project.name,
        raw: true,
        icon: 'folder' as const,
        link: ['/orgs', id, 'projects', project.id],
      })),
      { label: 'Profile', icon: 'user' as const, link: this.link('profile') },
    ];
  });

  constructor() {
    // Every navigation refreshes the frame, so a project created a moment ago appears at once.
    effect(() => {
      this.shell.url();
      this.session.profile();
      void this.shell.refresh();
    });
    effect(() => {
      this.navigation();
      this.menuOpen.set(false);
      this.orgMenuOpen.set(false);
      let route = this.route.snapshot;
      while (route.firstChild) route = route.firstChild;
      const labels = (route.data['crumbs'] as readonly string[] | undefined) ?? [];
      this.crumbs.set(labels.map((label) => ({ label })));
    });
  }

  protected count(entry: NavEntry): number | null {
    return entry.count ? entry.count() : null;
  }

  protected link(view: string): string[] {
    return ['/orgs', this.organizationId(), ...(VIEW_PATHS[view] ?? [])];
  }

  protected isActive(view: string): boolean {
    const base = `/orgs/${this.organizationId()}`;
    const path = this.shell.url().split(/[?#]/).at(0) ?? '';
    const target = [base, ...(VIEW_PATHS[view] ?? [])].join('/');
    return view === 'overview' ? path === base : path === target || path.startsWith(`${target}/`);
  }

  protected shortcut(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.paletteOpen.update((open) => !open);
    } else if (event.key === 'Escape') {
      this.menuOpen.set(false);
      this.orgMenuOpen.set(false);
    }
  }

  protected skipToContent(event: Event): void {
    event.preventDefault();
    const main = this.document.getElementById('main-content');
    main?.focus();
    main?.scrollIntoView();
  }
}
