import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { BlockView } from '../dashboard/block-view';
import { type Block } from '../dashboard/screen-model';
import { IdentityRequestError } from '../identity/identity-api';
import { Icon } from '../shell/icon';
import { type IconName } from '../shell/icons';
import { ShellContext } from '../shell/shell-context';
import { T } from '../ui/i18n';
import { OrganizationSettings } from './organization-settings';
import { type Organization, WorkspaceApi } from './workspace-api';

interface OrgSection {
  readonly k: string;
  readonly label: string;
  readonly icon: IconName;
}
const SECTIONS: readonly OrgSection[] = [
  { k: 'general', label: 'General', icon: 'building' },
  { k: 'members', label: 'Members', icon: 'users' },
  { k: 'invites', label: 'Invitations', icon: 'mail-forward' },
  { k: 'audit', label: 'Audit log', icon: 'history' },
  { k: 'danger', label: 'Danger zone', icon: 'alert-triangle' },
];
const DANGER: Block = {
  type: 'danger',
  items: [
    ['Transfer ownership', 'Another admin becomes the owner.', 'Transfer'],
    ['Delete the organization', 'Deletes projects, resources and linked servers.', 'Delete'],
  ],
};

/** 20 Organization: its name and identifier, members, and what can end it. */
@Component({
  selector: 'sk-organization-page',
  imports: [BlockView, Icon, OrganizationSettings, RouterLink, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-[18px]">
      <div class="page-head">
        <div class="min-w-0">
          <h1 class="page-title">{{ organization()?.name ?? '…' }}</h1>
          <div class="mt-1.5 text-[13px] text-mute2">
            {{
              'Organization · {members} members · {projects} projects'
                | t: { members: shell.members() ?? '—', projects: shell.projects().length }
            }}
          </div>
        </div>
      </div>
      @if (missing()) {
        <div class="alert" role="alert">{{ missing() | t }}</div>
      }
      <div class="grid items-start gap-7 md:grid-cols-[210px_minmax(0,1fr)]">
        <nav
          class="flex flex-col gap-0.5 max-md:flex-row max-md:overflow-x-auto md:sticky md:top-3"
          [attr.aria-label]="'Organization' | t"
        >
          @for (x of sections; track x.k) {
            <a
              class="sidenav-item max-md:whitespace-nowrap"
              [class.danger]="x.k === 'danger'"
              [routerLink]="[]"
              [queryParams]="{ section: x.k }"
              [attr.aria-current]="x.k === section() ? 'page' : null"
            >
              <sk-icon [name]="x.icon" /><span class="flex-1">{{ x.label | t }}</span>
            </a>
          }
        </nav>
        <div class="flex min-w-0 flex-col gap-4">
          <span class="sec-title">{{ current().label | t }}</span>
          @switch (section()) {
            @case ('general') {
              @if (organization(); as org) {
                <div class="card legacy-form p-5">
                  <sk-organization-settings [current]="org" (updated)="organization.set($event)" />
                </div>
              }
            }
            @case ('members') {
              <div class="note">
                <sk-icon name="users" class="text-mute" />
                <span>{{
                  '{n} members. Add people, change roles and see project roles under Members & access.'
                    | t: { n: shell.members() ?? '—' }
                }}</span>
              </div>
              <div>
                <a class="btn btn-sm" [routerLink]="['/orgs', organizationId(), 'members']">{{
                  'Open Members & access' | t
                }}</a>
              </div>
            }
            @case ('invites') {
              <div class="note note-warn">
                <sk-icon name="info-circle" class="text-amber" />
                <span>{{
                  'Email invitations are not built yet. For now, add people who already have an account, under Members & access.'
                    | t
                }}</span>
              </div>
            }
            @case ('audit') {
              <div class="note">
                <sk-icon name="info-circle" class="text-mute" />
                <span>{{ 'The full journal is on the Audit log screen.' | t }}</span>
              </div>
              <div>
                <a class="btn btn-sm" [routerLink]="['/orgs', organizationId(), 'audit']">{{
                  'Open the audit log' | t
                }}</a>
              </div>
            }
            @case ('danger') {
              <sk-block [block]="danger" [organizationId]="organizationId()" />
            }
          }
        </div>
      </div>
    </div>
  `,
})
export class OrganizationPage {
  private readonly api = inject(WorkspaceApi);
  protected readonly shell = inject(ShellContext);
  readonly organizationId = input.required<string>();
  protected readonly sections = SECTIONS;
  protected readonly danger = DANGER;
  protected readonly organization = signal<Organization | null>(null);
  protected readonly missing = signal<string | null>(null);
  private readonly query = toSignal(
    inject(ActivatedRoute).queryParamMap.pipe(map((q) => q.get('section'))),
  );
  protected readonly section = computed(() =>
    SECTIONS.some((s) => s.k === this.query()) ? (this.query() as string) : 'general',
  );
  protected readonly current = computed(
    () => SECTIONS.find((s) => s.k === this.section()) ?? SECTIONS[0],
  );

  constructor() {
    effect(() => {
      void this.load(this.organizationId());
    });
  }

  private async load(id: string): Promise<void> {
    this.missing.set(null);
    try {
      this.organization.set(await this.api.organization(id));
    } catch (error: unknown) {
      this.organization.set(null);
      this.missing.set(
        error instanceof IdentityRequestError
          ? error.message
          : 'This organization could not be loaded.',
      );
    }
  }
}
