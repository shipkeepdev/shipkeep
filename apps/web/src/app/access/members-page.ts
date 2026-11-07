import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  type ValidatorFn,
  Validators,
} from '@angular/forms';
import { RouterLink } from '@angular/router';

import { IdentityApi, type IdentitySchema } from '../identity/identity-api';
import { Icon } from '../shell/icon';
import { type IconName } from '../shell/icons';
import { ShellContext } from '../shell/shell-context';
import { T } from '../ui/i18n';
import { required } from '../workspace/validators';

import {
  AccessApi,
  type Binding,
  type Member,
  type OrganizationRole,
  type Proof,
} from './access-api';
import { PagedList } from './paged-list';
import { ReauthForm, reauthControls } from './reauth-form';

const email: ValidatorFn = (control) => Validators.email(control);

const COLUMNS =
  'grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1.6fr)_minmax(0,0.7fr)_minmax(0,1fr)]';
const ROLE_CELL: Record<string, { icon: IconName; color: string }> = {
  admin: { icon: 'crown', color: '#EDEDEF' },
  developer: { icon: 'rocket', color: '#EDEDEF' },
  viewer: { icon: 'eye', color: '#8B8B93' },
};

/** Organization members: adding existing accounts, changing roles and removing (SPEC 7). */
@Component({
  selector: 'sk-members-page',
  imports: [Icon, ReactiveFormsModule, RouterLink, ReauthForm, T],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h1 class="page-title">{{ 'Members & access' | t }}</h1>
          <div class="page-sub">
            {{
              'Roles per organization and per project. Changing a role or removing someone ends their sessions and invalidates their API tokens.'
                | t
            }}
          </div>
        </div>
        <button type="button" class="btn btn-primary" (click)="inviting.set(!inviting())">
          <sk-icon name="user-plus" />{{ 'Invite' | t }}
        </button>
      </div>
      @if (notice(); as text) {
        <p role="status" class="alert alert-ok">{{ text | t }}</p>
      }
      @if (inviting()) {
        <section
          class="card flex max-w-[720px] flex-col gap-3 p-5"
          aria-labelledby="add-member-title"
        >
          <h2 id="add-member-title" class="text-[15px] font-medium">{{ 'Add a member' | t }}</h2>
          <p class="text-[13px] text-mute">
            {{ 'The account must already exist and have a verified email.' | t }}
          </p>
          <sk-reauth-form
            prefix="member-add"
            [label]="'Add member' | t"
            [form]="addForm"
            [send]="addMember"
            (done)="added()"
          >
            <div class="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2.5 max-sm:grid-cols-1">
              <div class="flex flex-col gap-1.5">
                <label for="member-add-email" class="text-[12px] text-fg3">{{ 'Email' | t }}</label>
                <input
                  id="member-add-email"
                  class="input"
                  type="email"
                  [formControl]="addForm.controls.email"
                  maxlength="254"
                  autocomplete="off"
                  spellcheck="false"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <label for="member-add-role" class="text-[12px] text-fg3">{{ 'Role' | t }}</label>
                <select id="member-add-role" class="input" [formControl]="addForm.controls.role">
                  @for (role of roles; track role) {
                    <option [value]="role">{{ roleLabel(role) | t }}</option>
                  }
                </select>
              </div>
            </div>
            <button secondary class="btn btn-sm" type="button" (click)="inviting.set(false)">
              {{ 'Cancel' | t }}
            </button>
          </sk-reauth-form>
        </section>
      }
      @if (members.problem(); as problem) {
        <div class="alert" role="alert">{{ problem | t }}</div>
      }

      <div class="card overflow-x-auto">
        <div class="min-w-[720px]">
          <div
            [class]="
              columns + ' grid gap-3 border-b border-line px-5 py-2.5 text-[11.5px] text-dim2'
            "
          >
            <span>{{ 'Member' | t }}</span
            ><span>{{ 'Organization' | t }}</span
            ><span>{{ 'Projects' | t }}</span
            ><span>{{ 'State' | t }}</span
            ><span class="text-right">{{ 'Added' | t }}</span>
          </div>
          @if (members.state() === 'loading') {
            <p role="status" class="px-5 py-4 text-[13px] text-mute2">{{ 'Loading…' | t }}</p>
          }
          <div role="list" [attr.aria-label]="'Members' | t">
            @for (member of members.items(); track member.id) {
              <div role="listitem">
                <div
                  [class]="
                    columns + ' grid items-center gap-3 border-b border-line2 px-5 py-3 text-[13px]'
                  "
                >
                  <div class="flex min-w-0 items-center gap-2.5">
                    <div
                      class="grid size-[30px] shrink-0 place-items-center rounded-full bg-[#26262c] text-[11.5px] font-semibold"
                    >
                      {{ initials(member.email) }}
                    </div>
                    <div class="min-w-0">
                      <div class="truncate">{{ member.email.split('@')[0] }}</div>
                      <div class="truncate text-[11.5px] text-dim">{{ member.email }}</div>
                    </div>
                  </div>
                  <span class="text-[12.5px] text-fg2">{{ roleLabel(member.orgRole) | t }}</span>
                  <div class="flex flex-wrap gap-1.5">
                    @for (p of projectsOf(member); track p) {
                      <span class="rounded-md bg-chip px-2 py-[3px] text-[11px] text-fg3">{{
                        p
                      }}</span>
                    } @empty {
                      <span class="text-[12px] text-dim">—</span>
                    }
                  </div>
                  <span
                    class="flex items-center gap-1.5 text-[12px]"
                    [class.text-fg2]="member.active"
                    [class.text-amber]="!member.active"
                  >
                    <sk-icon
                      [name]="member.active ? 'shield-check' : 'shield-x'"
                      class="text-[15px]"
                    />{{ (member.active ? 'active' : 'disabled') | t }}
                  </span>
                  <div class="flex items-center justify-end gap-1.5">
                    <span class="mr-1 font-mono text-[11.5px] text-dim">{{
                      member.createdAt.slice(0, 10)
                    }}</span>
                    <button
                      type="button"
                      class="grid size-7 place-items-center rounded-lg border border-ctl text-fg3 hover:bg-hover"
                      [attr.aria-label]="'Change role of {email}' | t: { email: member.email }"
                      (click)="select(member, 'role')"
                    >
                      <sk-icon name="adjustments" class="text-[14px]" /><span class="sr-only">{{
                        'Change role' | t
                      }}</span>
                    </button>
                    <button
                      type="button"
                      class="grid size-7 place-items-center rounded-lg border border-ctl text-rose hover:bg-hover"
                      [attr.aria-label]="'Remove {email}' | t: { email: member.email }"
                      (click)="select(member, 'remove')"
                    >
                      <sk-icon name="trash" class="text-[14px]" /><span class="sr-only">{{
                        'Remove' | t
                      }}</span>
                    </button>
                  </div>
                </div>
                @if (selected()?.member?.id === member.id) {
                  <div class="border-b border-line2 bg-[#0a0a0b] px-5 py-4">
                    @if (selected()?.mode === 'role') {
                      <sk-reauth-form
                        prefix="member-role"
                        [label]="'Change role' | t"
                        [form]="roleForm"
                        [send]="changeRole"
                        (done)="finished('Role changed.')"
                      >
                        <div class="flex max-w-[260px] flex-col gap-1.5">
                          <label for="member-role-role" class="text-[12px] text-fg3">{{
                            'New role' | t
                          }}</label>
                          <select
                            id="member-role-role"
                            class="input"
                            [formControl]="roleForm.controls.role"
                          >
                            @for (role of roles; track role) {
                              <option [value]="role">{{ roleLabel(role) | t }}</option>
                            }
                          </select>
                        </div>
                        <button
                          secondary
                          class="btn btn-sm"
                          type="button"
                          (click)="selected.set(null)"
                        >
                          {{ 'Cancel' | t }}
                        </button>
                      </sk-reauth-form>
                    } @else {
                      <p class="mb-3 text-[13px] text-fg3">
                        {{
                          'This removes {email} from the organization and from every project and environment. An organization always keeps one owner.'
                            | t: { email: member.email }
                        }}
                      </p>
                      <sk-reauth-form
                        prefix="member-remove"
                        [label]="'Remove member' | t"
                        [form]="removeForm"
                        [send]="removeMember"
                        (done)="finished('Member removed.')"
                      >
                        <button
                          secondary
                          class="btn btn-sm"
                          type="button"
                          (click)="selected.set(null)"
                        >
                          {{ 'Cancel' | t }}
                        </button>
                      </sk-reauth-form>
                    }
                  </div>
                }
              </div>
            }
          </div>
          @if (members.hasMore()) {
            <div class="px-5 py-3">
              <button
                class="btn btn-sm"
                type="button"
                [disabled]="members.loadingMore()"
                (click)="members.more()"
              >
                {{ (members.loadingMore() ? 'Loading…' : 'Show more members') | t }}
              </button>
            </div>
          }
        </div>
      </div>

      <div class="flex flex-wrap items-start gap-3.5">
        <div class="card flex min-w-0 flex-[1_1_440px] flex-col gap-3.5 p-5">
          <div class="flex items-center justify-between">
            <span class="card-title">{{ 'Roles per project' | t }}</span>
            <sk-icon name="dots" class="text-[16px] text-dim" />
          </div>
          @if (matrix().projects.length) {
            <div class="overflow-x-auto rounded-[10px] border border-line">
              <div
                class="grid min-w-[420px] text-[12.5px]"
                [style.grid-template-columns]="
                  'minmax(0,1.2fr) repeat(' + matrix().projects.length + ',minmax(0,1fr))'
                "
              >
                <span class="border-b border-line2 bg-[#101012] px-3 py-2.5 text-dim"></span>
                @for (p of matrix().projects; track p.id) {
                  <span
                    class="flex items-center gap-1.5 truncate border-b border-l border-line2 bg-[#101012] px-3 py-2.5 text-mute"
                    ><sk-icon name="folder" class="text-[14px]" />{{ p.name }}</span
                  >
                }
                @for (r of matrix().rows; track r.email) {
                  <span class="truncate border-b border-line2 px-3 py-2.5 text-fg2">{{
                    r.email
                  }}</span>
                  @for (c of r.cells; track $index) {
                    <span
                      class="flex items-center gap-1.5 border-b border-l border-line2 px-3 py-2.5"
                      [style.color]="c.color"
                      ><sk-icon [name]="c.icon" class="text-[14px]" />{{ c.label | t }}</span
                    >
                  }
                }
              </div>
            </div>
          } @else {
            <p class="text-[13px] text-mute2">{{ 'No project yet.' | t }}</p>
          }
        </div>
        <div class="card min-w-0 flex-[1_1_440px] pt-[18px] pb-1.5">
          <div class="flex items-center justify-between px-[18px] pb-2.5">
            <span class="card-title">{{ 'Your API tokens' | t }}</span>
            <a
              [routerLink]="['/orgs', organizationId(), 'profile']"
              [queryParams]="{ section: 'tokens' }"
              class="flex items-center gap-[5px] text-[12px] text-mute hover:text-fg"
              ><sk-icon name="plus" class="text-[13px]" />{{ 'Create' | t }}</a
            >
          </div>
          @for (token of tokens(); track token.id) {
            <div
              class="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 border-t border-line2 px-[18px] py-[11px]"
            >
              <div class="grid size-7 place-items-center rounded-lg bg-chip">
                <sk-icon name="key" class="text-[14px] text-fg3" />
              </div>
              <div class="min-w-0">
                <div class="truncate font-mono text-[12px]">{{ token.name }}</div>
                <div class="mt-0.5 truncate text-[11px] text-dim">
                  {{ token.scopes.join(', ') }} ·
                  {{ 'expires {date}' | t: { date: token.expiresAt.slice(0, 10) } }}
                </div>
              </div>
              <span class="text-[11.5px] text-mute2">{{
                (token.lastUsedAt ? 'used {date}' : 'never used')
                  | t: { date: (token.lastUsedAt ?? '').slice(0, 10) }
              }}</span>
            </div>
          } @empty {
            <div class="border-t border-line2 px-[18px] py-[11px] text-[12.5px] text-dim">
              {{ 'No active token.' | t }}
            </div>
          }
        </div>
      </div>
    </div>
  `,
})
export class MembersPage {
  private readonly api = inject(AccessApi);
  private readonly identity = inject(IdentityApi);
  private readonly shell = inject(ShellContext);
  protected readonly columns = COLUMNS;
  protected readonly inviting = signal(false);
  protected readonly tokens = signal<readonly IdentitySchema<'ApiTokenDto'>[]>([]);
  private readonly bindings = signal<ReadonlyMap<string, readonly Binding[]>>(new Map());
  protected readonly matrix = computed(() => {
    const projects = this.shell.projects();
    const all = this.bindings();
    return {
      projects,
      rows: this.members.items().map((member) => ({
        email: member.email,
        cells: projects.map((project) => {
          const role = all.get(project.id)?.find((b) => b.userId === member.userId)?.role;
          const look = role ? ROLE_CELL[role] : undefined;
          return {
            label: role ?? 'none',
            icon: look?.icon ?? 'minus',
            color: look?.color ?? '#4C4C55',
          };
        }),
      })),
    };
  });
  readonly organizationId = input.required<string>();
  protected readonly roles: readonly OrganizationRole[] = ['member', 'admin', 'owner'];
  protected readonly members = new PagedList<Member>((cursor) =>
    this.api.members(this.organizationId(), cursor),
  );
  protected readonly selected = signal<{ member: Member; mode: 'role' | 'remove' } | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly addForm = new FormGroup({
    email: new FormControl('', { nonNullable: true, validators: [required, email] }),
    role: new FormControl<OrganizationRole>('member', { nonNullable: true }),
    ...reauthControls(),
  });
  protected readonly roleForm = new FormGroup({
    role: new FormControl<OrganizationRole>('member', { nonNullable: true }),
    ...reauthControls(),
  });
  protected readonly removeForm = new FormGroup(reauthControls());

  protected readonly addMember = (proof: Proof, key: string): Promise<void> => {
    const { email, role } = this.addForm.getRawValue();
    return this.api.addMember(this.organizationId(), { email, role, ...proof }, key);
  };
  protected readonly changeRole = (proof: Proof, key: string): Promise<void> => {
    const { role } = this.roleForm.getRawValue();
    return this.api.changeRole(this.organizationId(), this.targetId(), { role, ...proof }, key);
  };
  protected readonly removeMember = (proof: Proof, key: string): Promise<void> =>
    this.api.removeMember(this.organizationId(), this.targetId(), proof, key);

  constructor() {
    effect(() => {
      this.organizationId();
      this.selected.set(null);
      this.notice.set(null);
      void this.members.refresh();
    });
    effect(() => {
      const projects = this.shell.projects();
      const organizationId = this.organizationId();
      void Promise.all(
        projects.map(async (project) => {
          const page = await this.api
            .bindings({ organizationId, projectId: project.id })
            .catch(() => null);
          return [project.id, page?.items ?? []] as const;
        }),
      ).then((entries) => {
        this.bindings.set(new Map(entries));
      });
    });
    void this.identity
      .listTokens()
      .then((page) => {
        this.tokens.set(page.items.filter((token) => token.status === 'active'));
      })
      .catch(() => {
        this.tokens.set([]);
      });
  }

  protected projectsOf(member: Member): readonly string[] {
    if (member.orgRole !== 'member') return ['All projects'];
    return this.shell
      .projects()
      .filter((project) =>
        this.bindings()
          .get(project.id)
          ?.some((b) => b.userId === member.userId),
      )
      .map((project) => project.name);
  }

  protected roleLabel(role: OrganizationRole): string {
    return { owner: 'Owner', admin: 'Admin', member: 'Member' }[role];
  }

  protected initials(email: string): string {
    return (email.split('@').at(0) ?? '')
      .split(/[._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.at(0)?.toUpperCase() ?? '')
      .join('');
  }

  protected select(member: Member, mode: 'role' | 'remove'): void {
    this.notice.set(null);
    this.roleForm.reset({ role: member.orgRole });
    this.removeForm.reset();
    this.selected.set({ member, mode });
  }
  protected finished(notice: string): void {
    this.selected.set(null);
    this.notice.set(notice);
    void this.members.refresh();
  }
  protected added(): void {
    this.addForm.reset();
    this.finished('Member added.');
  }

  private targetId(): string {
    const target = this.selected();
    if (!target) throw new Error('No member is selected.');
    return target.member.id;
  }
}
