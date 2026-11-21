import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { Icon } from '../shell/icon';
import { type IconName } from '../shell/icons';
import { ShellContext } from '../shell/shell-context';
import { I18n, T } from '../ui/i18n';

import { FirstStartStore } from './first-start-store';

/** What the API reported. A null count could not be read: it neither ticks nor opens a step. */
export interface FirstStartFacts {
  readonly organization: string;
  readonly role: string | null;
  readonly servers: number | null;
  readonly readyServers: number;
  readonly registries: number;
  readonly applications: number | null;
  /** Whether an application served once; null when that could not be read. */
  readonly deployed: boolean | null;
}

export interface FirstStartStep {
  readonly title: string;
  readonly detail: string;
  /** A counted detail: `detail` is its singular form and this its plural, both with `{n}`. */
  readonly count?: { readonly n: number; readonly other: string };
  readonly params?: Readonly<Record<string, string | number>>;
  readonly icon: IconName;
  /** Null when the API could not say. */
  readonly done: boolean | null;
  readonly cta?: {
    readonly label: string;
    readonly link: readonly string[];
    readonly section?: string;
  };
}

const UNREAD = 'Could not be read right now.';

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
      detail:
        facts.servers === null
          ? UNREAD
          : facts.servers
            ? '{n} server enrolled, {ready} ready.'
            : 'Generate a 15-minute token and run one command on the machine.',
      count: facts.servers
        ? { n: facts.servers, other: '{n} servers enrolled, {ready} ready.' }
        : undefined,
      params: { ready: facts.readyServers },
      icon: 'server-2',
      done: facts.servers === null ? null : facts.servers > 0,
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
      done:
        facts.registries > 0 || (facts.applications ?? 0) > 0
          ? true
          : facts.applications === null
            ? null
            : false,
      cta: { label: 'Registries', link: [...org, 'organization'], section: 'registries' },
    },
    {
      title: 'Deploy an application',
      detail:
        facts.deployed === null
          ? UNREAD
          : facts.deployed
            ? 'An application is deployed.'
            : facts.applications
              ? 'An application exists: deploy it from its page.'
              : 'From a shipkeep.yml with an image, in an environment of a project.',
      icon: 'rocket',
      done: facts.deployed,
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
  providers: [FirstStartStore],
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
        @if (unread() && !store.loading()) {
          <button class="btn btn-sm" type="button" (click)="read(organizationId())">
            {{ 'Read again' | t }}
          </button>
        }
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
              <span class="sr-only">{{
                (s.done ? 'Done' : s.done === null ? 'Unknown' : 'To do') | t
              }}</span>
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
  protected readonly store = inject(FirstStartStore);
  private readonly shell = inject(ShellContext);
  private readonly i18n = inject(I18n);
  readonly organizationId = input.required<string>();

  protected readonly steps = computed(() =>
    firstStartSteps(this.organizationId(), {
      organization: this.shell.organization()?.name ?? '…',
      role: this.shell.role(),
      ...this.store.facts(),
      registries: this.store.registries(),
    }),
  );
  protected readonly next = computed(
    () => this.steps().find((step) => step.done === false) ?? null,
  );
  protected readonly unread = computed(() => this.steps().some((step) => step.done === null));
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
      void untracked(() => this.store.load(organizationId));
    });
    // The role arrives with the shell: registries are read once it says they may be, and only
    // with a role read for this organization, not the one just left.
    effect(() => {
      const organizationId = this.organizationId();
      const role = this.shell.roleIn(organizationId);
      untracked(() => {
        this.store.readRegistries(organizationId, role);
      });
    });
  }

  protected read(organizationId: string): void {
    void this.store.load(organizationId);
    this.store.readRegistries(organizationId, this.shell.roleIn(organizationId));
  }
}
