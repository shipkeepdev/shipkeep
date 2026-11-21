import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { Icon } from '../shell/icon';
import { type IconName } from '../shell/icons';
import { ShellContext } from '../shell/shell-context';
import { I18n, T } from '../ui/i18n';

import { OverviewStore } from './overview-store';
import { WorkspaceApi } from './workspace-api';

export interface FirstStartFacts {
  readonly organization: string;
  readonly role: string | null;
  readonly servers: number;
  readonly readyServers: number;
  readonly registries: number;
  readonly applications: number;
  readonly deployed: number;
}
export interface FirstStartStep {
  readonly title: string;
  readonly detail: string;
  /** A counted detail: `detail` is its singular form and this its plural, both with `{n}`. */
  readonly count?: { readonly n: number; readonly other: string };
  readonly params?: Readonly<Record<string, string | number>>;
  readonly icon: IconName;
  readonly done: boolean;
  readonly cta?: {
    readonly label: string;
    readonly link: readonly string[];
    readonly section?: string;
  };
}

const ROLE_LABELS: Readonly<Record<string, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

/**
 * The four steps of a first start (issue #269), each ticked from what the API reports, never from
 * a stored flag. Pure, so the rules are tested apart from the page.
 */
export function firstStartSteps(organizationId: string, facts: FirstStartFacts): FirstStartStep[] {
  const org = ['/orgs', organizationId];
  return [
    {
      title: 'Create organization',
      detail: facts.role ? '{name} · you are {role}' : '{name}',
      params: { name: facts.organization, role: ROLE_LABELS[facts.role ?? ''] ?? '' },
      icon: 'building',
      done: true,
    },
    {
      title: 'Add your first server',
      detail: facts.servers
        ? '{n} server enrolled, {ready} ready.'
        : 'Generate a 15-minute token and run one command on the machine.',
      count: facts.servers
        ? { n: facts.servers, other: '{n} servers enrolled, {ready} ready.' }
        : undefined,
      params: { ready: facts.readyServers },
      icon: 'server-2',
      done: facts.servers > 0,
      cta: { label: facts.servers ? 'Servers' : 'Add a server', link: [...org, 'servers'] },
    },
    {
      title: 'Choose where images come from',
      detail: facts.registries
        ? '{n} private registry stored.'
        : 'Public images need nothing. Store a private registry once; Git sources come later.',
      count: facts.registries
        ? { n: facts.registries, other: '{n} private registries stored.' }
        : undefined,
      icon: 'git-branch',
      done: facts.registries > 0 || facts.applications > 0,
      cta: { label: 'Registries', link: [...org, 'organization'], section: 'registries' },
    },
    {
      title: 'Deploy an application',
      detail: facts.deployed
        ? '{n} application deployed.'
        : facts.applications
          ? 'An application exists: deploy it from its page.'
          : 'From a shipkeep.yml with an image, in an environment of a project.',
      count: facts.deployed
        ? { n: facts.deployed, other: '{n} applications deployed.' }
        : undefined,
      icon: 'rocket',
      done: facts.deployed > 0,
      cta: {
        label: facts.applications ? 'Applications' : 'New application',
        link: [...org, facts.applications ? 'applications' : 'new'],
      },
    },
  ];
}

/** 24 First start, on the organization's real state. */
@Component({
  selector: 'sk-first-start-page',
  imports: [Icon, RouterLink, T],
  providers: [OverviewStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page gap-[18px]">
      <div class="page-head">
        <div class="min-w-0">
          <h1 class="page-title">{{ 'Welcome to Shipkeep' | t }}</h1>
          <div class="mt-1.5 text-[13px] text-mute2">
            @if (store.loading()) {
              {{ 'Loading…' | t }}
            } @else {
              {{ 'Four steps. {done} of 4 done.' | t: { done: done() } }}
            }
          </div>
        </div>
      </div>
      <ol class="flex flex-col gap-2.5" [attr.aria-busy]="store.loading()">
        @for (s of steps(); track s.title) {
          @let active = s === next();
          <li
            class="flex items-center gap-4 rounded-2xl border bg-black px-[18px] py-4 max-sm:flex-wrap"
            [class.border-line2]="!active"
            [class.step-active]="active"
            [attr.aria-current]="active ? 'step' : null"
          >
            <span
              class="grid size-[30px] shrink-0 place-items-center rounded-full border"
              [class.step-dot-done]="s.done"
              [class.border-line2]="!s.done"
            >
              <sk-icon [name]="s.done ? 'check' : s.icon" class="text-[15px]" />
              <span class="sr-only">{{ (s.done ? 'Done' : 'To do') | t }}</span>
            </span>
            <div class="min-w-0 flex-1 max-sm:basis-[calc(100%-46px)]">
              <div class="text-[14px]" [class.text-mute2]="s.done">{{ s.title | t }}</div>
              <div class="mt-[3px] text-[12.5px] text-mute2">
                {{ detail(s) }}
              </div>
            </div>
            @if (s.cta; as cta) {
              <a
                class="btn btn-sm font-medium max-sm:ml-[46px]"
                [class.btn-primary]="active"
                [routerLink]="cta.link"
                [queryParams]="cta.section ? { section: cta.section } : null"
                >{{ cta.label | t }}</a
              >
            }
          </li>
        }
      </ol>
    </div>
  `,
  styles: `
    .step-active {
      border-color: rgb(255 92 92 / 40%);
    }
    .step-dot-done {
      border-color: #f2f2f3;
      background: #f2f2f3;
      color: #000;
    }
  `,
})
export class FirstStartPage {
  protected readonly store = inject(OverviewStore);
  private readonly api = inject(WorkspaceApi);
  private readonly shell = inject(ShellContext);
  private readonly i18n = inject(I18n);
  readonly organizationId = input.required<string>();
  private readonly registries = signal(0);
  #revision = 0;

  protected readonly steps = computed(() =>
    firstStartSteps(this.organizationId(), {
      organization: this.shell.organization()?.name ?? '…',
      role: this.shell.role(),
      servers: this.store.nodes()?.length ?? 0,
      readyServers: this.store.readyNodes(),
      registries: this.registries(),
      applications: this.store.applications().length,
      deployed: this.store
        .applications()
        .filter((app) => app.deployments.some((d) => d.state === 'succeeded')).length,
    }),
  );
  protected readonly next = computed(() => this.steps().find((step) => !step.done) ?? null);
  protected readonly done = computed(() => this.steps().filter((step) => step.done).length);

  protected detail(step: FirstStartStep): string {
    const params = step.params ?? {};
    // The role is a label of its own, translated before it enters the sentence.
    const values =
      typeof params['role'] === 'string'
        ? { ...params, role: this.i18n.t(params['role']) }
        : params;
    return step.count
      ? this.i18n.count(step.count.n, step.detail, step.count.other, values)
      : this.i18n.t(step.detail, values);
  }

  constructor() {
    effect(() => {
      const organizationId = this.organizationId();
      const revision = ++this.#revision;
      void this.store.load(organizationId);
      // Only admins read registries; for the others the step stands on applications alone.
      void this.api
        .registries(organizationId)
        .catch(() => [])
        .then((found) => {
          if (revision === this.#revision) this.registries.set(found.length);
        });
    });
  }
}
